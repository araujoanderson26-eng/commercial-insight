import {useState} from 'react';
export function CategoryFilter({values,include,exclude,onChange}:{values:string[];include:string[];exclude:string[];onChange:(include:string[],exclude:string[])=>void}){
 const [search,S]=useState(''),[mode,M]=useState<'include'|'exclude'>('include');
 const selected=mode==='include'?include:exclude;
 const options=[...new Set([...values,...include,...exclude])].sort((a,b)=>a.localeCompare(b,'pt-BR'));
 function set(next:string[]){onChange(mode==='include'?next:include,mode==='exclude'?next:exclude);}
 return <fieldset className="category-filter"><legend>Categorias comerciais</legend>
 <div className="report-actions"><button type="button" className={mode==='include'?'primary':'soft'} aria-pressed={mode==='include'} onClick={()=>M('include')}>Incluir</button><button type="button" className={mode==='exclude'?'primary':'soft'} aria-pressed={mode==='exclude'} onClick={()=>M('exclude')}>Excluir</button></div>
 <label>Pesquisar categorias<input type="search" value={search} onChange={e=>S(e.target.value)} /></label>
 <div className="report-actions"><button type="button" className="soft compact" onClick={()=>set(options)}>Marcar todas</button><button type="button" className="soft compact" onClick={()=>set([])}>Limpar seleção</button><button type="button" className="soft compact" onClick={()=>onChange([],[])}>Limpar filtros de categorias</button></div>
 <div className="category-options">{options.filter(v=>v.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'))).map(v=><label key={v}><input type="checkbox" checked={selected.includes(v)} onChange={()=>set(selected.includes(v)?selected.filter(x=>x!==v):[...selected,v])}/><span>{v}</span></label>)}{!options.length&&<p>Nenhuma categoria disponível no catálogo autorizado.</p>}</div>
 <p className="sub">Incluir: {include.join(', ')||'Todas as categorias'}</p><p className="sub">Excluir: {exclude.join(', ')||'Nenhuma'}. A exclusão prevalece.</p>
 </fieldset>;
}
