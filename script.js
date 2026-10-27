(function weddingApp(){
  "use strict";
  const one=s=>document.querySelector(s),all=s=>Array.from(document.querySelectorAll(s)),c=window.WEDDING_CONFIG||{};
  const date=/^\d{4}-\d{2}-\d{2}$/.test(c.date||"")?new Date(c.date+"T12:00:00"):new Date("2027-06-19T12:00:00");
  const dateLabel=new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric"}).format(date);
  const month=new Intl.DateTimeFormat("ru-RU",{month:"long"}).format(date);
  const first=c.names?.first||"Лера",second=c.names?.second||"Макс";
  const text=(s,v)=>{const e=one(s);if(e)e.textContent=v};
  document.title=first+" и "+second+" — приглашение на свадьбу";
  text("#hero-date-script",first+" + "+second+" · "+dateLabel);
  text("#date-callout",dateLabel+" в "+(c.dateTime||"15:00"));
  text("#calendar-month",month);text("#venue-name",c.venueName||"Место проведения");
  text("#venue-address",(c.venueAddress||"Адрес будет здесь")+" (демо)");
  text("#signature","ваши "+first+" и "+second+" ♡");
  if(c.rsvpDeadline&&/^\d{4}-\d{2}-\d{2}$/.test(c.rsvpDeadline))text("#rsvp-deadline","ответьте, пожалуйста, до "+new Intl.DateTimeFormat("ru-RU").format(new Date(c.rsvpDeadline+"T12:00:00")));
  const map=one("#venue-map");if(map&&/^https:\/\//.test(c.venueMapUrl||""))map.href=c.venueMapUrl;
  (c.schedule||[]).slice(0,4).forEach((v,i)=>{if(Array.isArray(v)){text("#timeline-t"+(i+1),v[0]);text(".stop-"+(i+1)+" .timeline-text",v[1])}});
  [["#hero-photo-one",c.heroImages?.[0]],["#hero-photo-two",c.heroImages?.[1]],["#venue-photo",c.venueImage]].forEach(([sel,url])=>{
    const img=one(sel);if(!img)return;img.addEventListener("load",()=>img.classList.add("loaded"));img.addEventListener("error",()=>img.classList.remove("loaded"));
    if(url&&/^(https:\/\/|\.\/|assets\/)/.test(url))img.src=url;
  });
  const cal=one("#calendar-grid");
  if(cal){["пн","вт","ср","чт","пт","сб","вс"].forEach(v=>{const el=document.createElement("span");el.textContent=v;el.className="weekday";cal.append(el)});
    const start=new Date(date.getFullYear(),date.getMonth(),1),offset=(start.getDay()+6)%7;
    for(let i=0;i<42;i++){const d=new Date(date.getFullYear(),date.getMonth(),1-offset+i),el=document.createElement("span");el.textContent=String(d.getDate());el.className="cal-day";if(d.getMonth()!==date.getMonth())el.classList.add("muted");if(d.getMonth()===date.getMonth()&&d.getDate()===date.getDate()){el.classList.add("chosen");el.setAttribute("aria-label","День свадьбы")};cal.append(el)}
  }
  one("#save-date")?.addEventListener("click",()=>{
    const pad=n=>String(n).padStart(2,"0"),d=String(date.getFullYear())+pad(date.getMonth()+1)+pad(date.getDate()),time=(c.dateTime||"15:00").split(":"),hour=Number(time[0]||15),minute=Number(time[1]||0);
    const dt=(h)=>d+"T"+pad(h)+pad(minute)+"00",ics=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Wedding//RU","BEGIN:VEVENT","DTSTART:"+dt(hour),"DTEND:"+dt(hour+5),"SUMMARY:Свадьба — "+first+" и "+second,"LOCATION:"+(c.venueAddress||"").replace(/[,;\\]/g," "),"END:VEVENT","END:VCALENDAR"].join("\r\n");
    const u=URL.createObjectURL(new Blob([ics],{type:"text/calendar;charset=utf-8"})),a=document.createElement("a");a.href=u;a.download="save-the-date.ics";a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
  });
  const reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
  if("IntersectionObserver" in window&&!reduce){const obs=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add("is-visible");obs.unobserve(e.target)}}),{threshold:.1});all(".reveal").forEach(e=>obs.observe(e))}else all(".reveal").forEach(e=>e.classList.add("is-visible"));
  const path=one("#timeline-ink"),fill=one("#reading-line-fill"),top=one(".back-to-top"),timeline=one("#timeline-inner"),len=path?.getTotalLength()||0;
  if(path){path.style.strokeDasharray=String(len);path.style.strokeDashoffset=String(len)}
  let ticking=false;function scroll(){const max=document.documentElement.scrollHeight-innerHeight,p=max>0?scrollY/max:0;if(fill)fill.style.transform="scaleX("+Math.max(0,Math.min(1,p))+")";top?.classList.toggle("shown",scrollY>700);
    if(path&&timeline&&len){const box=timeline.getBoundingClientRect(),value=Math.max(0,Math.min(1,(innerHeight*.66-box.top)/(box.height+innerHeight*.25)));path.style.strokeDashoffset=String(len*(1-value))}ticking=false}
  addEventListener("scroll",()=>{if(!ticking){requestAnimationFrame(scroll);ticking=true}},{passive:true});addEventListener("resize",scroll,{passive:true});scroll();
  one("#envelope")?.addEventListener("click",e=>{const b=e.currentTarget;b.setAttribute("aria-expanded",String(b.classList.toggle("open")))});
  const form=one("#rsvp-form"),extra=one("#attending-fields"),endpoint=String(c.rsvpEndpoint||"").trim(),demo=!/^https:\/\//.test(endpoint),err=one("#form-error");
  text("#mode-note",demo?"Демо-режим: ответы пока не сохраняются и никуда не отправляются. Позже подключим Telegram или почту.":"Ваш ответ будет передан организаторам праздника.");
  function conditional(){const attending=form.querySelector('input[name="attending"]:checked')?.value||"",hide=!!attending&&attending!=="Да, конечно!";extra.classList.toggle("inactive",hide);extra.querySelectorAll("input,textarea").forEach(e=>e.disabled=hide);err.hidden=true}
  form?.addEventListener("change",conditional);
  form?.addEventListener("submit",async e=>{
    e.preventDefault();err.hidden=true;const f=new FormData(form),name=String(f.get("name")||"").trim(),attending=String(f.get("attending")||"");
    if(!name||!attending||!f.get("consent")){err.textContent="Укажите имя, выберите ответ и подтвердите согласие.";err.hidden=false;(!name?form.elements.name:!attending?form.querySelector('input[name="attending"]'):form.elements.consent)?.focus();return}
    if(String(f.get("website")||"").trim()){err.textContent="Не удалось отправить ответ.";err.hidden=false;return}
    const yes=attending==="Да, конечно!",payload={name,attending,additionalGuests:yes?String(f.get("additionalGuests")||"").trim():"",drinks:yes?f.getAll("drinks").map(String):[],food:yes?String(f.get("food")||"").trim():"",message:String(f.get("message")||"").trim(),createdAt:new Date().toISOString(),consent:true};
    const success=msg=>{form.hidden=true;one("#rsvp-success").hidden=false;text("#success-message",msg);one("#rsvp-success").scrollIntoView({behavior:reduce?"auto":"smooth",block:"center"})};
    if(demo){success("Анкета заполнена, но это демо: данные не отправлены и не сохранены.");return}
    const btn=one("#rsvp-submit");btn.disabled=true;btn.textContent="отправляем...";
    try{const r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});if(!r.ok)throw Error(String(r.status));success("Ваш ответ доставлен организаторам. Спасибо! ♡")}
    catch{err.textContent="Не удалось отправить ответ. Попробуйте позже или напишите организаторам напрямую.";err.hidden=false}finally{btn.disabled=false;btn.textContent="отправить ответ ♡"}
  });
  one("#edit-answer")?.addEventListener("click",()=>{one("#rsvp-success").hidden=true;form.hidden=false;form.scrollIntoView({behavior:reduce?"auto":"smooth"})});
})();
