// Отдельный Cloudflare Worker. НИКОГДА не публикуйте BOT_TOKEN и CHAT_ID.
// Secrets: BOT_TOKEN, CHAT_ID. Environment variable: ALLOWED_ORIGIN.
export default {
  async fetch(request, env) {
    const allowed=env.ALLOWED_ORIGIN;
    const origin=request.headers.get("Origin")||"";
    const headers={"Access-Control-Allow-Origin":origin===allowed?allowed:"null","Vary":"Origin","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Content-Type":"application/json"};
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers});
    if(request.method!=="POST"||!allowed||origin!==allowed)return new Response('{"ok":false}',{status:403,headers});
    const size=Number(request.headers.get("Content-Length")||0);
    if(size>8192)return new Response('{"ok":false}',{status:413,headers});
    let body;try{body=await request.json()}catch{return new Response('{"ok":false}',{status:400,headers})}
    if(!body||typeof body.name!=="string"||body.name.trim().length<2||body.name.length>120||!["Да, конечно!","К сожалению, нет","Отвечу чуть позже"].includes(body.attending)||body.consent!==true)return new Response('{"ok":false}',{status:400,headers});
    const clean=x=>String(x||"").replace(/[<>]/g,"").slice(0,2500);
    const msg=["💌 Ответ на приглашение","Имя: "+clean(body.name),"Присутствие: "+clean(body.attending),"С кем: "+clean(body.additionalGuests),"Напитки: "+(Array.isArray(body.drinks)?body.drinks.map(clean).join(", "):""),"Меню: "+clean(body.food),"Сообщение: "+clean(body.message),"Дата: "+clean(body.createdAt)].join("\n").slice(0,3900);
    if(!env.BOT_TOKEN||!env.CHAT_ID)return new Response('{"ok":false}',{status:503,headers});
    const res=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:env.CHAT_ID,text:msg})});
    return new Response(JSON.stringify({ok:res.ok}),{status:res.ok?200:502,headers});
  }
};