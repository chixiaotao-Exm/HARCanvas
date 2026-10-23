/** Each response read belongs to one record identity and one live request. */
export function createResponseReadScope(){
 let identity='',generation=0,controller:AbortController|undefined;
 const cancel=()=>{generation++;controller?.abort();controller=undefined;};
 const select=(next:string)=>{if(next!==identity){cancel();identity=next;}};
 return {
  select,cancel,
  begin(next:string){
   select(next);cancel();
   const current=new AbortController(),version=generation;
   controller=current;
   return {signal:current.signal,isCurrent:()=>!current.signal.aborted&&generation===version&&identity===next};
  },
 };
}
