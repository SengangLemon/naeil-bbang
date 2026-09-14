import {z} from "zod";
import {MODEL_GZIP_B64,DEMO_GZIP_B64} from "@/lib/embedded-models";
import {readState,database,productStatement,recordStatement,recordImportStatements,forecastStatement,planStatement,batchStatements} from "@/lib/store";
import {productSchema,parseRecord,planSchema,validateManualQuantity,errorMessage,balanceDifference} from "@/lib/validation";
import {prepareImport} from "@/lib/csv";
import {buildForecast,type ModelPack} from "@/lib/model-engine";
import {localDate,addDays,type Space,type Product,type DayRecord,type Forecast,type Plan,type AppState} from "@/lib/bakery-types";
export const dynamic="force-dynamic";
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
const spaceOf=(value:unknown):Space=>value==="demo"?"demo":"real";
let packPromise:Promise<ModelPack>|null=null;
async function unpack<T>(text:string):Promise<T>{const bytes=Uint8Array.from(atob(text),c=>c.charCodeAt(0));const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));return await new Response(stream).json() as T;}
async function getPack(){if(!packPromise)packPromise=unpack<ModelPack>(MODEL_GZIP_B64).catch(e=>{packPromise=null;throw e;});return packPromise;}
export async function GET(request:Request){try{return reply(await readState(spaceOf(new URL(request.url).searchParams.get("space"))));}catch(e){console.error("bakery-read",e);return reply({error:"저장된 기록을 불러오지 못했습니다. 새로고침하거나 잠시 후 다시 시도해 주세요."},503);}}
export async function POST(request:Request){
 try{
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return reply({error:"같은 앱 화면에서 요청해 주세요."},403);
  const contentType=request.headers.get("content-type")??"";if(!contentType.includes("application/json"))return reply({error:"올바른 입력 형식이 아닙니다."},415);
  const text=await request.text();if(text.length>1500000)return reply({error:"한 번에 가져올 수 있는 크기를 초과했습니다."},413);
  const body=JSON.parse(text),space=spaceOf(body.space);const state=await readState(space);
  const now=new Date().toISOString();
  if(body.action==="product_save"){
   const parsed=productSchema.parse(body.product);const existing=parsed.id?state.products.find(p=>p.id===parsed.id):null;
   if(parsed.id&&!existing)throw new Error("상품을 찾을 수 없습니다.");if(state.products.some(p=>p.name===parsed.name&&p.id!==parsed.id))throw new Error("같은 이름의 상품이 있습니다.");
   const product:Product={...parsed,id:existing?.id??crypto.randomUUID()};await productStatement(space,product).run();return reply({product});
  }
  if(body.action==="record_save"){
   const parsed=parseRecord(body.record);if(!state.products.some(p=>p.id===parsed.productId))throw new Error("상품을 먼저 등록해 주세요.");
   const record:DayRecord={...parsed,id:`${space}|${parsed.productId}|${parsed.date}`,source:space==="demo"?"synthetic":"manual",updatedAt:now};
   await recordStatement(space,record).run();return reply({record,balanceDifference:balanceDifference(record)});
  }
  if(body.action==="plan_preview"||body.action==="plan_commit"){
   const input=planSchema.parse(body.plan),product=state.products.find(p=>p.id===input.productId);if(!product)throw new Error("상품을 선택해 주세요.");
   const existing=state.forecasts.find(f=>f.productId===input.productId&&f.target===input.target);
   if(existing)return reply({forecast:existing,plan:state.plans.find(p=>p.forecastId===existing.id),frozen:true});
   if(state.records.some(r=>r.productId===input.productId&&r.date>=input.target))throw new Error("이미 실제 판매를 알고 있는 날짜에는 새 예측을 저장할 수 없습니다. 저장해 둔 예측과만 비교합니다.");
   if(input.target<=localDate()&&space==="real")throw new Error("지난 날짜의 예측을 뒤늦게 만들 수 없습니다. 오늘 날짜를 선택하고 내일 생산계획을 만들어 주세요.");
   if(input.target>addDays(localDate(),1))throw new Error("이번 앱은 다음 날 생산계획을 계산합니다. 내일 날짜를 선택해 주세요.");
   const context={inventory:input.inventory,reservations:input.reservations,batch:product.batch,capacity:product.capacity};
   const forecast=buildForecast(await getPack(),state,product,input.target,context);
   if(body.action==="plan_preview")return reply({forecast,frozen:false});
   const quantity=body.quantity===undefined?forecast.models[0].quantity:validateManualQuantity(body.quantity,product);
   const plan:Plan={id:forecast.id,forecastId:forecast.id,productId:product.id,target:input.target,quantity,updatedAt:now};
   await database().batch([forecastStatement(space,forecast),planStatement(space,plan,true)]);
   const saved=await readState(space);return reply({forecast:saved.forecasts.find(f=>f.id===forecast.id),plan:saved.plans.find(p=>p.id===plan.id),frozen:true});
  }
  if(body.action==="plan_quantity"){
   const id=z.string().max(300).parse(body.id),plan=state.plans.find(p=>p.id===id);if(!plan)throw new Error("저장한 생산계획이 없습니다.");
   if(state.records.some(r=>r.productId===plan.productId&&r.date>=plan.target))throw new Error("실제 기록이 입력된 생산계획은 바꿀 수 없습니다. 실제 생산량을 마감 기록에 입력해 주세요.");
   const forecast=state.forecasts.find(f=>f.id===plan.forecastId)!;
   const quantity=validateManualQuantity(body.quantity,forecast.context);const updated={...plan,quantity,updatedAt:now};await planStatement(space,updated).run();return reply({plan:updated});
  }
  if(body.action==="import_preview"||body.action==="import_commit"){
   const csv=z.string().min(1).max(1000000).parse(body.csv),result=prepareImport(csv,state.products,state.records);
   if(body.action==="import_preview")return reply({count:result.records.length,newProducts:result.newProducts.map(p=>p.name),errors:result.errors.slice(0,30),errorCount:result.errors.length,warnings:result.warnings,preview:result.records.slice(0,5).map(r=>({...r,product:result.newProducts.find(p=>p.id===r.productId)?.name??state.products.find(p=>p.id===r.productId)?.name}))});
   if(result.errors.length)throw new Error(`가져오기 전에 ${result.errors.length}개 오류를 수정해 주세요. ${result.errors[0]}`);
   const records:DayRecord[]=result.records.map(r=>({...r,id:`${space}|${r.productId}|${r.date}`,source:"import",updatedAt:now}));
   // Schema stays migration-owned. Inserts are idempotent on product/date keys.
   await batchStatements([...result.newProducts.map(p=>productStatement(space,p)),...recordImportStatements(space,records)]);
   return reply({count:records.length,warnings:result.warnings});
  }
  if(body.action==="demo_seed"){
   if(space!=="demo")throw new Error("예시 기록은 예시 공간에서만 사용할 수 있습니다.");
   if(state.products.length)return reply({ready:true});
   const demo=await unpack<AppState>(DEMO_GZIP_B64);
   await batchStatements([...demo.products.map(p=>productStatement("demo",p)),...demo.records.map(r=>recordStatement("demo",r)),...demo.forecasts.map(f=>forecastStatement("demo",f)),...demo.plans.map(p=>planStatement("demo",p,true))]);
   return reply({ready:true});
  }
  return reply({error:"지원하지 않는 요청입니다."},400);
 }catch(e){console.error("bakery-write",e);return reply({error:errorMessage(e)},400);}
}
