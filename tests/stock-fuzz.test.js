// Fuzz de stock en facturas (ronda 8 de la auditoria). Correr: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descontarStock, devolverStock, itemsADescontar, faltantesDeStock, CATS_STOCK, tieneStock } from '../src/data/stock.js';
let seed = Number(process.argv[2]||1); const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff}; const ri=(a,b)=>a+Math.floor(rnd()*(b-a+1)); const pick=a=>a[ri(0,a.length-1)];
const RESTOCK = process.argv[3]==='restock';
const fails={};const fail=(k,m)=>{fails[k]=fails[k]||[];if(fails[k].length<2)fails[k].push(m)};
test('fuzz de stock en facturas: invariantes (alta, edicion, borrado, viejas, sin stock)', () => {
for(let run=0;run<1500;run++){
 const cats=Object.keys(CATS_STOCK); let data={invoices:[],quotations:[],remitos:[]}; const prods=[];
 for(const cat of cats){data[CATS_STOCK[cat]]=[];for(let i=0;i<3;i++){const id=`${cat}-${i}`;const st=rnd()<0.75?ri(0,8):(rnd()<0.5?undefined:'');const p={id,name:id};if(st!==undefined)p.stock=st;data[CATS_STOCK[cat]].push(p);prods.push({cat,id})}}
 const initial={};const added={};for(const c of cats)for(const p of data[CATS_STOCK[c]]) if(tieneStock(p)){initial[c+p.id]=Number(p.stock);added[c+p.id]=0}
 const deleted=new Set();
 const randCart=()=>{const n=ri(1,4);const m=new Map();for(let i=0;i<n;i++){const p=pick(prods);const k=p.cat+p.id;if(m.has(k))m.get(k).quantity+=ri(1,3);else m.set(k,{id:p.id,name:p.id,_cat:p.cat,quantity:ri(1,6),price:1})}if(rnd()<0.3)m.set('l',{id:'libre-1',_cat:'libre',quantity:2,price:3});return [...m.values()]};
 const stockOf=(d,cat,id)=>{const p=(d[CATS_STOCK[cat]]||[]).find(x=>x.id===id);return p&&tieneStock(p)?Number(p.stock):null};
 const contrib=(c)=>c._descontado!==undefined?Number(c._descontado):(c._cat==='equiposNuevos'?0:Number(c.quantity));
 const check=(tag)=>{for(const k in initial){const [cat]=cats.filter(c=>k.startsWith(c));const id=k.slice(cat.length);const s=stockOf(data,cat,id);if(s===null)continue;
   if(s<0)fail('neg',tag+' '+k+' '+s);
   const sum=data.invoices.flatMap(i=>i.cartItems).filter(c=>c._cat===cat&&c.id===id).reduce((a,c)=>a+contrib(c),0);
   if(s!==initial[k]+added[k]-sum)fail('ledger',`${tag} ${k} stock=${s} exp=${initial[k]+added[k]-sum}`)}};
 const checkWarn=(tag,before,cartForDesc,prevItems,result)=>{
   const warn=faltantesDeStock(before,cartForDesc.cart,prevItems);
   // actual clipping: item where _descontado + _sinDescontar < quantity and product has stock
   const req=itemsADescontar(cartForDesc.cart,prevItems);const clipped=result.filter((c,i)=>CATS_STOCK[c._cat]&&stockOf(before,c._cat,c.id)!==null&&Number(c._descontado)<(req[i]._aDescontar!==undefined?req[i]._aDescontar:Number(req[i].quantity)));
   if(!!warn.length!==!!clipped.length)fail('warn',`${tag} warn=${JSON.stringify(warn)} clipped=${JSON.stringify(clipped.map(c=>[c.id,c.quantity,c._descontado,c._sinDescontar]))}`)};
 let nid=0;
 for(let step=0;step<25;step++){
  const op=rnd();const snap=JSON.stringify(data);
  if(op<0.25){const cart=randCart();const before=data;const r=descontarStock(data,cart);data={...r.next,invoices:[...data.invoices,{id:'i'+nid++,cartItems:r.items}]};checkWarn('new',before,{cart},[],r.items)}
  else if(op<0.35){const cart=randCart();// legacy
    let d={...data};const ok=cart.every(c=>c._cat==='equiposNuevos'||c._cat==='libre'||stockOf(d,c._cat,c.id)===null||stockOf(d,c._cat,c.id)>=c.quantity);
    if(ok){for(const c of cart){if(c._cat==='mascarillas'||c._cat==='descartables'){const key=CATS_STOCK[c._cat];d[key]=d[key].map(p=>p.id===c.id&&tieneStock(p)?{...p,stock:Number(p.stock)-c.quantity}:p)}}
     d.invoices=[...d.invoices,{id:'i'+nid++,cartItems:cart.map(c=>({...c}))}];data=d}}
  else if(op<0.42){const cart=randCart();const k=pick(['quotations','remitos']);data={...data,[k]:[...data[k],{id:'q'+nid++,cartItems:cart}]};if(JSON.stringify({...data,[k]:undefined})!==JSON.stringify({...JSON.parse(snap),[k]:undefined}))fail('cot','moved')}
  else if(op<0.75&&data.invoices.length){const inv=pick(data.invoices);
    let cart=inv.cartItems.map(i=>{const c={...i,quantity:Number(i.quantity)||1};delete c._descontado;delete c._sinDescontar;return c});
    const nochange=rnd()<0.35;
    if(!nochange){cart=cart.map(c=>rnd()<0.5?{...c,quantity:Math.max(1,c.quantity+ri(-3,3))}:c).filter(()=>rnd()<0.85);
      for(const n of randCart()){const e=cart.find(c=>c.id===n.id&&c._cat===n._cat);if(e)e.quantity+=n.quantity;else if(rnd()<0.5)cart.push(n)}
      if(!cart.length)cart=randCart()}
    const before=data;const previo=inv;let next=devolverStock(data,previo.cartItems);const r=descontarStock(next,itemsADescontar(cart,previo.cartItems));
    data={...r.next,invoices:data.invoices.map(x=>x.id===inv.id?{id:inv.id,cartItems:r.items}:x)};
    checkWarn('edit',before,{cart},previo.cartItems,r.items);
    if(nochange){for(const p of prods){const a=stockOf(before,p.cat,p.id),b=stockOf(data,p.cat,p.id);if(a!==b)fail('nochange',`${p.cat}${p.id} ${a}->${b} prev=${JSON.stringify(previo.cartItems.filter(c=>c.id===p.id))}`)}}
    // edit twice no change
    }
  else if(op<0.85&&data.invoices.length){const inv=pick(data.invoices);data={...data,invoices:data.invoices.filter(x=>x!==inv)};data=devolverStock(data,inv.cartItems)}
  else if(op<0.92&&RESTOCK){const p=pick(prods);const key=CATS_STOCK[p.cat];const k=p.cat+p.id;if(k in initial&&!deleted.has(k)){const n=ri(1,5);data={...data,[key]:data[key].map(x=>x.id===p.id?{...x,stock:Number(x.stock)+n}:x)};added[k]+=n}}
  else {const p=pick(prods);const key=CATS_STOCK[p.cat];deleted.add(p.cat+p.id);data={...data,[key]:data[key].filter(x=>x.id!==p.id)}}
  check('step'+step)
 }
 // delete all
 for(const inv of [...data.invoices]){data={...data,invoices:data.invoices.filter(x=>x!==inv)};data=devolverStock(data,inv.cartItems)}
 for(const k in initial){if(deleted.has(k))continue;const cat=cats.find(c=>k.startsWith(c));const s=stockOf(data,cat,k.slice(cat.length));if(s!==initial[k]+added[k])fail('restore',`${k} ${s} vs ${initial[k]+added[k]}`)}
}
assert.deepEqual(fails, {}, 'invariantes de stock');
});
