import test from 'node:test';
import assert from 'node:assert/strict';
import {YES, NO, LATER, normalizeAnswer, nextParkingStatus, summarize, describeChanges, exportCsv, editKeyHash, verifyEditKey} from '../worker/rsvp-policy.mjs';
const answer = (fields={}) => normalizeAnswer({name:'Семья',attending:YES,guestCount:3,additionalGuests:'Два имени, еще запятая',drinks:['Виски','Ром'],otherDrink:'Сидр',parking:'yes',carCount:2,message:'До встречи',consent:true,...fields});
test('Guest count is numeric and independent of punctuation in names', () => {
  assert.equal(answer().guestCount, 3);
  assert.equal(answer({guestCount:1}).additionalGuests, '');
  for (const value of [0, -1, 1.5, '3', NaN, Infinity]) assert.throws(()=>answer({guestCount:value}));
});
test('Declined/pending answers cannot retain company, drinks or parking data', () => {
  for (const attending of [NO,LATER]) {
    const value=answer({attending});
    assert.equal(value.guestCount,0); assert.deepEqual(value.drinks,[]);
    assert.equal(value.parking,null);assert.equal(value.carCount,null);assert.equal(value.otherDrink,'');
  }
});
test('Parking request can exceed capacity, but only changed car count/choice resets review', () => {
  const before={answer:answer(),parkingStatus:'approved'};
  assert.equal(answer({carCount:9}).carCount,9);
  assert.equal(nextParkingStatus(before,answer({message:'Новое',drinks:['Ром'],guestCount:2})),'approved');
  assert.equal(nextParkingStatus(before,answer({carCount:1})),'pending');
  assert.equal(nextParkingStatus(before,answer({parking:'no'})),'not_requested');
  assert.equal(nextParkingStatus(before,answer({attending:NO})),'not_requested');
});
test('Statistics count current records and companies per drink, never guests per drink', () => {
  const rows=[{answer:answer({drinks:['Виски','Виски'],carCount:2}),parkingStatus:'approved'},{answer:answer({guestCount:2,carCount:1}),parkingStatus:'pending'},{answer:answer({attending:NO})},{answer:answer({attending:LATER})}];
  const stats=summarize(rows);assert.equal(stats.forms,4);assert.equal(stats.confirmedGuests,5);assert.equal(stats.drinks['Виски'],2);assert.equal(stats.approvedCars,2);assert.equal(stats.freeCars,6);assert.equal(stats.pendingCompanies,1);assert.equal(stats.declinedCompanies,1);
  rows[0].answer=answer({guestCount:1,drinks:['Ром']});assert.equal(summarize(rows).confirmedGuests,3);assert.equal(summarize(rows).drinks['Виски'],1);
  rows.splice(0,1);assert.equal(summarize(rows).confirmedGuests,2);
});
test('Change notification describes exact current field changes', () => {
  const changes=describeChanges(answer(),answer({guestCount:2}));assert.equal(changes.length,1);assert.match(changes[0],/было 3 → стало 2/);
});
test('CSV escapes formulas/quotes/newlines and cannot export edit secrets', () => {
  const csv=exportCsv([{id:'abc',answer:answer({name:'=SUM(1,2)',message:'"привет"\nстрока'}),parkingStatus:'pending',editKey:'SECRET',editKeyHash:'HASH'}]);
  assert.ok(csv.includes("'=SUM"));assert.ok(csv.includes('""привет""'));assert.ok(!csv.includes('SECRET')&&!csv.includes('HASH'));
});
test('Edit key hash binds a random secret to its record, rejects other record/key', async () => {
  const id='12345678-1234-1234-1234-123456789012',key='a'.repeat(43),hash=await editKeyHash(id,key);
  assert.equal(hash.length,64);assert.equal(await verifyEditKey(id,key,hash),true);
  assert.equal(await verifyEditKey(id,'b'.repeat(43),hash),false);
  assert.equal(await verifyEditKey('22345678-1234-1234-1234-123456789012',key,hash),false);
  assert.equal(await verifyEditKey(id,'bad',hash),false);
});
