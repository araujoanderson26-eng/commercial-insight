export function KpiSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="kpis" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div className="kpi skeleton-kpi" key={index}>
          <span className="skeleton skeleton-line w-60" />
          <span className="skeleton skeleton-value w-80" />
          <span className="skeleton skeleton-pill w-45" />
          <span className="skeleton skeleton-line w-70" />
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <section className="panel graph skeleton-panel" aria-hidden="true">
      <div className="sectionhead">
        <div className="skeleton-col">
          <span className="skeleton skeleton-line w-35" />
          <span className="skeleton skeleton-title w-55" />
        </div>
        <span className="skeleton skeleton-pill w-20" />
      </div>
      <div className="skeleton skeleton-chart" />
    </section>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <section className="panel skeleton-panel" aria-hidden="true">
      <div className="sectionhead">
        <span className="skeleton skeleton-title w-40" />
        <span className="skeleton skeleton-pill w-15" />
      </div>
      <div className="skeleton-table">
        {Array.from({ length: rows }).map((_, index) => (
          <div className="skeleton-row" key={index}>
            <span className="skeleton skeleton-line w-45" />
            <span className="skeleton skeleton-line w-20" />
            <span className="skeleton skeleton-line w-20" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ReportSkeleton({
  withTable = false,
  withSignals = false,
}: {
  withTable?: boolean;
  withSignals?: boolean;
}) {
  return (
    <div className="stack" role="status" aria-label="Carregando indicadores">
      <KpiSkeleton />
      {withSignals ? (
        <div className="analytics">
          <ChartSkeleton />
          <TableSkeleton rows={4} />
        </div>
      ) : (
        <ChartSkeleton />
      )}
      {withTable && <TableSkeleton rows={6} />}
    </div>
  );
}

export function AppBootSkeleton() {
  return (
    <div className="boot-shell" role="status" aria-label="Abrindo Comercial Insight">
      <div className="boot-bar">
        <img src="/icon-192.png" width={36} height={36} alt="" />
        <span>
          Comercial <strong>Insight</strong>
        </span>
      </div>
      <div className="boot-body">
        <div className="skeleton skeleton-hero" />
        <KpiSkeleton count={4} />
        <ChartSkeleton />
      </div>
    </div>
  );
}
