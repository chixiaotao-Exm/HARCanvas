export type GroupSize={width:number;height:number};
export type GroupMeasurements=Map<string,GroupSize>;
const key=(id:string,expanded:boolean)=>JSON.stringify([id,expanded]);

/** View-only groups are rebuilt on runtime updates; keep their measured size. */
export function groupDimensions(sizes:GroupMeasurements,id:string,expanded:boolean){
 return {initialWidth:288,initialHeight:expanded?82:240,measured:sizes.get(key(id,expanded))};
}

export function rememberGroupDimensions(sizes:GroupMeasurements,id:string,expanded:boolean,size:GroupSize):GroupMeasurements{
 if(!Number.isFinite(size.width)||!Number.isFinite(size.height)||size.width<=0||size.height<=0)return sizes;
 const entry=key(id,expanded),previous=sizes.get(entry);
 if(previous?.width===size.width&&previous?.height===size.height)return sizes;
 const next=new Map(sizes);next.set(entry,{width:size.width,height:size.height});return next;
}
