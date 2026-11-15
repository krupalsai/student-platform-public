import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {getAdminSnapshot} from '../../src/lib/admin-copilot';
const fixtures = {
 profiles: [
  {college:'GNIT',batch_id:'b1',is_profile_complete:true,created_at:'2026-09-27T10:00:00Z'},
  {college:'GNIT',batch_id:'b1',is_profile_complete:true,created_at:'2026-09-28T04:00:00Z'},
 ],
 payments: [
  {status:'approved',amount:2500,created_at:'2026-09-27T10:00:00Z',reviewed_at:'2026-09-28T04:00:00Z',batch_id:'b1'},
  {status:'approved',amount:1800,created_at:'2026-09-28T04:00:00Z',reviewed_at:'2026-09-27T12:00:00Z',batch_id:'b1'},
  {status:'submitted',amount:1000,created_at:'2026-09-28T04:00:00Z',reviewed_at:null,batch_id:'b1'},
 ],
 batches:[{id:'b1',name:'GNIT Batch 1',college:'GNIT',fee_amount:2500,status:'active'}],
 batch_waiting_queue:[],unknown_questions:[],
};
function fakeDb() {return {from(table:string){return {select(_cols:string,_opts?:unknown){return {
 eq(_field:string,_v:unknown){return this}, neq(_field:string,_v:unknown){return this}, is(_field:string,_v:unknown){return this},
 then(resolve:any){return Promise.resolve({data:(fixtures as any)[table],count:0}).then(resolve)}
}}}}} as any}
test('today payment metrics use reviewed_at, not submission date',async()=>{
 const saved=Date.now; Date.now=()=>Date.parse('2026-09-28T05:00:00Z');
 try {const s=await getAdminSnapshot(fakeDb());assert.equal(s.today.approvedPayments,1);assert.equal(s.today.collected,2500);assert.equal(s.totalCollected,4300);assert.equal(s.today.registrations,1)} finally{Date.now=saved}
});
