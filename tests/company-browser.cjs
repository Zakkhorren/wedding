const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const config = fs.readFileSync(path.join(root,'site.config.js'),'utf8');
assert.ok(config.includes("rsvpEndpoint: ''"), 'Production endpoint must remain disconnected');
const server = http.createServer((req,res) => {
  const name = new URL(req.url,'http://localhost').pathname;
  const file = path.resolve(root,'.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const type = {'.css':'text/css','.js':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.html':'text/html'}[path.extname(file)];
    res.setHeader('Content-Type',type || 'text/plain'); res.end(fs.readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  try {
    for (const width of [320,375,390,430,768,1024,1440]) {
      await page.setViewportSize({width,height:900});
      await page.goto(base); await page.evaluate(()=>document.fonts.ready);
      assert.equal(await page.locator('#attending-fields').isVisible(),false);
      assert.equal(await page.locator('[name=drinks]').first().isEnabled(),false);
      await page.locator('[name=attending]').first().check();
      assert.equal(await page.locator('#attending-fields').isVisible(),true);
      assert.equal(await page.locator('[name=guestCount]').inputValue(),'1');
      assert.equal(await page.locator('#guest-minus').isEnabled(),false);
      assert.equal(await page.locator('#additional-guests-field').isVisible(),false);
      await page.locator('#guest-plus').click(); await page.locator('#guest-plus').click();
      assert.equal(await page.locator('[name=guestCount]').inputValue(),'3');
      assert.equal(await page.locator('#additional-guests-field').isVisible(),true);
      await page.locator('[name=additionalGuests]').fill('Одно имя, второе, еще запятая');
      assert.equal(await page.locator('[name=guestCount]').inputValue(),'3');
      await page.locator('#guest-minus').click(); await page.locator('#guest-minus').click();
      assert.equal(await page.locator('[name=additionalGuests]').isEnabled(),false);
      assert.equal(await page.locator('#parking-fields').isVisible(),true);
      await page.locator('[name=attending]').nth(1).check();
      assert.equal(await page.locator('#attending-fields').isVisible(),false);
      await page.locator('[name=attending]').nth(2).check();
      assert.equal(await page.locator('#attending-fields').isVisible(),false);
      await page.locator('[name=attending]').first().check();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator('.guest-count-block').scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
      fs.mkdirSync(path.join(root,'.qa'),{recursive:true});
      await page.locator('.guest-count-block').screenshot({path:path.join(root,`.qa/company-counter-${width}.png`)});
    }
    let status=200, body={ok:true}, payloads=[];
    await page.route('**/site.config.js',route=>route.fulfill({contentType:'text/javascript',body:config.replace("rsvpEndpoint: ''","rsvpEndpoint: 'https://rsvp.test/answer'")}));
    await page.route('https://rsvp.test/answer',route=>{
      payloads.push(route.request().postDataJSON());
      return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.reload();
    await page.locator('[name=name]').fill('Тестовая компания');
    await page.locator('[name=attending]').first().check();
    await page.locator('[name=consent]').check();
    await page.locator('[name=guestCount]').fill('0');
    await page.locator('#rsvp-submit').click();
    assert.equal(payloads.length,0); assert.equal(await page.locator('#form-error').isVisible(),true);
    await page.locator('[name=guestCount]').fill('3');
    await page.locator('[name=additionalGuests]').fill('Имена, с, несколькими, запятыми');
    await page.locator('[name=drinks][value="Виски"]').check();
    await page.locator('[name=drinks][value="Ром"]').check();
    await page.locator('[name=parking][value=yes]').check();
    await page.locator('[name=carCount]').fill('2');
    body={ok:false};
    await page.locator('#rsvp-submit').click();
    await page.locator('#form-error').waitFor({state:'visible'});
    assert.equal(await page.locator('#rsvp-success').isVisible(),false,'HTTP 200 is not sufficient without acknowledgement');
    body={ok:true};
    await page.locator('#rsvp-submit').click(); await page.locator('#rsvp-success').waitFor({state:'visible'});
    assert.equal(payloads.at(-1).guestCount,3); assert.deepEqual(payloads.at(-1).drinks,['Виски','Ром']); assert.equal(payloads.at(-1).carCount,2);
    await page.locator('#edit-answer').click(); await page.locator('[name=guestCount]').fill('1');
    await page.locator('#rsvp-submit').click(); await page.locator('#rsvp-success').waitFor({state:'visible'});
    assert.equal(payloads.at(-1).guestCount,1); assert.equal(payloads.at(-1).additionalGuests,'');
    for (const index of [1,2]) {
      await page.locator('#edit-answer').click(); await page.locator('[name=attending]').nth(index).check();
      await page.locator('#rsvp-submit').click(); await page.locator('#rsvp-success').waitFor({state:'visible'});
      const result=payloads.at(-1);assert.equal(result.guestCount,0);assert.equal(result.parking,null);assert.equal(result.carCount,null);assert.deepEqual(result.drinks,[]);assert.equal(result.additionalGuests,'');
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: seven widths, compact counter, attendance conditions, numerical guestCount, multiple drinks, parking, acknowledged POST and inactive-field exclusion; no real API requests');
  } finally { await browser.close(); server.close(); }
})().catch(error=>{ console.error(error); server.close(); process.exitCode=1; });
