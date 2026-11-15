import { SupabaseClient } from "@supabase/supabase-js";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";

export async function checkAndNotifyLowSeats(db: SupabaseClient, batchId: string): Promise<void> {
  const { data: batch } = await db.from("batches").select("id,name,college,batch_limit,low_seat_alert_threshold,low_seat_alert_sent_at").eq("id", batchId).maybeSingle();
  if (!batch || !batch.batch_limit || !batch.low_seat_alert_threshold || batch.low_seat_alert_sent_at) return;
  const { count } = await db.from("profiles").select("*",{count:"exact",head:true}).eq("batch_id",batchId).eq("is_profile_complete",true);
  const remaining=batch.batch_limit-(count??0);
  if(remaining>batch.low_seat_alert_threshold||remaining<0)return;
  await db.from("batches").update({low_seat_alert_sent_at:new Date().toISOString()}).eq("id",batchId).is("low_seat_alert_sent_at",null);
  const phones=await getActiveAdminPhones(db); if(!phones.length)return;
  const word=remaining===1?"seat":"seats";
  const message=`⚠️ Low Seats Alert\n\n${batch.name} (${batch.college}) has only ${remaining} ${word} left out of ${batch.batch_limit}.\n\nConsider raising the limit or preparing a new batch.`;
  await Promise.all(phones.map(p=>sendWhatsAppText(p,message).catch(()=>false)));
}
