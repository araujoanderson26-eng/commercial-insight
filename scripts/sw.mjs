import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const files = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  "/vinhedo.webp",
  "/icon-192.png",
  "/icon-180.png",
  "/icon-512.png",
  "/icon-maskable.png",
  ...readdirSync("dist/assets").map((x) => "/assets/" + x),
];

const routes = [
  "/",
  "/inicio",
  "/conversas",
  "/clientes",
  "/produtos",
  "/relatorios",
  "/visitas",
  "/alertas",
  "/equipe",
  "/integracoes",
  "/admin/atualizacao-dados",
  "/auditoria",
  "/perfil",
  "/mais",
  "/redefinir",
];

const sha = createHash("sha256");
for (const f of files) {
  sha.update(readFileSync(f === "/" ? "dist/index.html" : "dist" + f));
}
const key = "ci-static-" + sha.digest("hex").slice(0, 16);

writeFileSync(
  "dist/sw.js",
  `
const NAME=${JSON.stringify(key)},FILES=${JSON.stringify(files)},ROUTES=${JSON.stringify(routes)};
self.addEventListener('install',e=>e.waitUntil(caches.open(NAME).then(c=>c.addAll(FILES))));
self.addEventListener('message',e=>{if(e.data==='ACTIVATE')self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith('ci-static-')&&k!==NAME)await caches.delete(k);await self.clients.claim()})()));
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/'))return;
  if(r.mode==='navigate'&&ROUTES.includes(u.pathname)){
    e.respondWith((async()=>{
      const c=await caches.open(NAME);
      try{
        const net=await fetch(r);
        if(net&&net.ok&&u.pathname==='/')c.put('/',net.clone()).catch(()=>{});
        return net;
      }catch{
        return (await c.match('/'))||(await c.match('/offline.html'))||Response.error();
      }
    })());
    return;
  }
  if(!u.search&&u.pathname.startsWith('/assets/')&&FILES.includes(u.pathname)){
    e.respondWith(caches.open(NAME).then(async c=>(await c.match(u.pathname))||fetch(r)));
    return;
  }
  if(!u.search&&FILES.includes(u.pathname)){
    e.respondWith(caches.open(NAME).then(async c=>{
      const cached=await c.match(u.pathname);
      const fresh=fetch(r).then(res=>{if(res&&res.ok)c.put(u.pathname,res.clone()).catch(()=>{});return res;}).catch(()=>cached);
      return cached||fresh;
    }));
  }
});
`,
);
