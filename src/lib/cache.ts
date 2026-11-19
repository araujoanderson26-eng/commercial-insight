import type { Filters, Plan, Report, Session } from "../../shared/domain";

export type CacheKind = "report" | "options";

type CacheRecord = {
  compositeKey: string;
  scope: string;
  key: string;
  kind: CacheKind;
  value: unknown;
  savedAt: number;
  expiresAt: number;
};

const DB_NAME = "commercial-insight-cache-v1";
const STORE_NAME = "entries";
const SESSION_SNAPSHOT_KEY = "ci:session-snapshot:v1";
const MAX_MEMORY_ITEMS = 120;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const memoryCache = new Map<string, CacheRecord>();
let dbPromise: Promise<IDBDatabase | null> | null = null;
let cacheEpoch = 0;

function composite(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

function touchMemory(record: CacheRecord): void {
  memoryCache.delete(record.compositeKey);
  memoryCache.set(record.compositeKey, record);
  while (memoryCache.size > MAX_MEMORY_ITEMS) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "compositeKey" });
          store.createIndex("by_scope", "scope", { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        resolve(null);
      };
      req.onblocked = () => resolve(null);
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });
  return dbPromise;
}

/** Builds a cache isolation key scoped by user, policy version and data snapshot. */
export function makeScope(session: Pick<Session, "user" | "policyVersion" | "data">): string {
  return [
    session.user.id,
    session.policyVersion,
    session.data?.source ?? "powerbi",
    session.data?.activeVersionId ?? "live",
  ].join("|");
}

export function canonicalFiltersKey(filters: Filters): string {
  const sortedArray = (values?: string[]) =>
    values?.length ? [...new Set(values)].sort((a, b) => a.localeCompare(b)) : [];
  return JSON.stringify({
    from: filters.from,
    to: filters.to,
    region: filters.region ?? "",
    client: filters.client ?? "",
    product: filters.product ?? "",
    regional: filters.regional ?? "",
    state: filters.state ?? "",
    manager: filters.manager ?? "",
    category: filters.category ?? "",
    categoriesInclude: sortedArray(filters.categoriesInclude),
    categoriesExclude: sortedArray(filters.categoriesExclude),
  });
}

export function canonicalPlanKey(plan: Plan): string {
  return `report:${plan.group}:${plan.metric}:${plan.order}:${canonicalFiltersKey(plan.filters)}`;
}

export function optionsCacheKey(filters: Filters): string {
  return `options:${canonicalFiltersKey({
    ...filters,
    category: "",
    categoriesInclude: [],
    categoriesExclude: [],
  })}`;
}

export function getCachedSync<T>(scope: string, key: string): T | null {
  if (!scope) return null;
  const ck = composite(scope, key);
  const record = memoryCache.get(ck);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    memoryCache.delete(ck);
    return null;
  }
  touchMemory(record);
  return record.value as T;
}

export async function getCached<T>(scope: string, key: string): Promise<T | null> {
  const inMemory = getCachedSync<T>(scope, key);
  if (inMemory !== null) return inMemory;
  if (!scope) return null;
  const epoch = cacheEpoch;
  const db = await openDb();
  if (!db || epoch !== cacheEpoch) return null;
  const ck = composite(scope, key);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(ck);
      req.onsuccess = () => {
        if (epoch !== cacheEpoch) {
          resolve(null);
          return;
        }
        const record = req.result as CacheRecord | undefined;
        if (!record) {
          resolve(null);
          return;
        }
        if (record.expiresAt <= Date.now()) {
          void deleteRecord(db, ck);
          resolve(null);
          return;
        }
        touchMemory(record);
        resolve(record.value as T);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function deleteRecord(db: IDBDatabase, ck: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(ck);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function setCached<T>(
  scope: string,
  key: string,
  kind: CacheKind,
  value: T,
  ttlMs = DEFAULT_TTL_MS,
): void {
  if (!scope) return;
  const now = Date.now();
  const record: CacheRecord = {
    compositeKey: composite(scope, key),
    scope,
    key,
    kind,
    value,
    savedAt: now,
    expiresAt: now + Math.max(1000, ttlMs),
  };
  touchMemory(record);
  const epoch = cacheEpoch;
  void openDb().then((db) => {
    if (!db || epoch !== cacheEpoch) return;
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
    } catch {
      // Ignore quota or private-mode IDB failures; RAM cache remains intact.
    }
  });
}

export function listCachedReportsSync(scope: string): Report[] {
  if (!scope) return [];
  const now = Date.now();
  const out: Report[] = [];
  for (const [ck, record] of memoryCache.entries()) {
    if (record.expiresAt <= now) {
      memoryCache.delete(ck);
      continue;
    }
    if (record.scope === scope && record.kind === "report") out.push(record.value as Report);
  }
  return out;
}

export async function listCachedReports(scope: string): Promise<Report[]> {
  const fromRam = listCachedReportsSync(scope);
  if (!scope) return fromRam;
  const epoch = cacheEpoch;
  const db = await openDb();
  if (!db || epoch !== cacheEpoch) return fromRam;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const index = tx.objectStore(STORE_NAME).index("by_scope");
      const req = index.getAll(scope);
      req.onsuccess = () => {
        if (epoch !== cacheEpoch) {
          resolve(fromRam);
          return;
        }
        const now = Date.now();
        const byKey = new Map<string, Report>();
        for (const r of fromRam) byKey.set(canonicalPlanKey(r.plan), r);
        for (const record of (req.result as CacheRecord[] | undefined) ?? []) {
          if (record.kind !== "report") continue;
          if (record.expiresAt <= now) {
            void deleteRecord(db, record.compositeKey);
            continue;
          }
          touchMemory(record);
          byKey.set(record.key, record.value as Report);
        }
        resolve([...byKey.values()]);
      };
      req.onerror = () => resolve(fromRam);
    } catch {
      resolve(fromRam);
    }
  });
}

export function saveSessionSnapshot(session: Session): void {
  try {
    if (typeof sessionStorage !== "undefined")
      sessionStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify(session));
  } catch {
    // Ignore storage unavailability.
  }
}

export function loadSessionSnapshot(): Session | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(SESSION_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed?.user?.id || parsed.expires * 1000 <= Date.now()) {
      sessionStorage.removeItem(SESSION_SNAPSHOT_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function purgeClientCache(): Promise<void> {
  cacheEpoch++;
  memoryCache.clear();
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(SESSION_SNAPSHOT_KEY);
  } catch {
    // Ignore storage errors.
  }
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
