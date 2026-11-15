-- RAG corpus seed: ports the RAG assistant's hand-written Q&A pairs
-- (~/workspace/rag-assistant/corpus.json) into the live `faqs` table,
-- so the existing retrieval pipeline (retrieveRelevantFaqs ->
-- generateGroundedAnswer) answers them on WhatsApp and in-app.
-- Source of truth: supabase/seed-data/rag-corpus.json — this file was
-- generated from it; extend there and in a new migration.
-- Deliberately NOT ported: fee-01 (hardcodes Rs 2200 — fees are
-- per-batch; the bot must use STUDENT CONTEXT / the Payments tab),
-- reg-01 (duplicates live FAQ 'How do I register'), fee-03
-- (duplicates live FAQ 'My payment failed'). fee-04 was ported
-- with the hardcoded amount removed; support-02 corrected to
-- GNIT, GNITC and BIET. Embeddings are left NULL — the admin
-- reindex route (POST /api/admin/faqs/reindex) backfills them;
-- trigram/keyword/lexical retrieval works immediately.
-- Idempotent: each row inserts only if its question is absent.

insert into faqs (category, question, answer, keywords)
select 'registration', 'I tried to log in but it says my mobile number is not registered. What do I do?', 'That message means you have not registered yet. Tap the Register on WhatsApp button on the login page. The WhatsApp bot will send you a registration link. Register first, then log in with the one-time link the bot sends you.', array['login','mobile','number','registered','register']
where not exists (select 1 from faqs f where f.question = 'I tried to log in but it says my mobile number is not registered. What do I do?');

insert into faqs (category, question, answer, keywords)
select 'registration', 'Do I need a password to log in to the Student Platform?', 'No. The platform has no passwords. You log in with a one-time link sent to your registered WhatsApp number. The link works once and expires after 10 minutes. If it expires, ask the bot for a new one.', array['password','login','link','whatsapp','expires']
where not exists (select 1 from faqs f where f.question = 'Do I need a password to log in to the Student Platform?');

insert into faqs (category, question, answer, keywords)
select 'fees', 'How do I pay the fee? Which payment methods work?', 'Pay on the platform''s payment page using UPI, debit card, or credit card. Payments go through Razorpay. After payment, the system checks the payment automatically with the payment gateway. Do not send screenshots or UTR numbers — the verification is automatic.', array['pay','fee','payment','upi','razorpay','card','methods']
where not exists (select 1 from faqs f where f.question = 'How do I pay the fee? Which payment methods work?');

insert into faqs (category, question, answer, keywords)
select 'fees', 'Can I pay the fee in two parts?', 'No. The fee is paid as one single total on the payment page, not in two parts. Check your Payments tab for the current amount.', array['pay','fee','two','parts','installment','split']
where not exists (select 1 from faqs f where f.question = 'Can I pay the fee in two parts?');

insert into faqs (category, question, answer, keywords)
select 'case-tracking', 'How do I track my High Court case on the platform?', 'Open the case tracking section in the app. It shows your writ petition''s live status from the High Court: Filed, Registered, Order, or Disposed. The app fetches the status automatically by case number, so you do not need to visit the court website.', array['track','case','court','petition','status','high']
where not exists (select 1 from faqs f where f.question = 'How do I track my High Court case on the platform?');

insert into faqs (category, question, answer, keywords)
select 'case-tracking', 'What does it mean when my case status says Disposed?', 'Disposed means the court has finished with the case and passed an order. For the student batches, the court directed the college to return the students'' original certificates. After disposal, the next step is collecting the hard copy of the court order from the college.', array['disposed','case','status','meaning','order','court']
where not exists (select 1 from faqs f where f.question = 'What does it mean when my case status says Disposed?');

insert into faqs (category, question, answer, keywords)
select 'case-tracking', 'When will I get the hard copy of the court order?', 'The college gives the hard copy a few days after the court order. The exact day is announced in your batch group. The person who receives the hard copy should prepare a reference copy using the sample in the app and share it in the batch group.', array['hard','copy','court','order','when','collect']
where not exists (select 1 from faqs f where f.question = 'When will I get the hard copy of the court order?');

insert into faqs (category, question, answer, keywords)
select 'case-tracking', 'Who is the key person for my batch''s writ petition?', 'The first-listed petitioner on the writ petition is the key person for the batch. The lawyer sends the hard copy of the court order to that one person, so the key person must be present at the college first to collect it.', array['key','person','petitioner','batch','petition','first']
where not exists (select 1 from faqs f where f.question = 'Who is the key person for my batch''s writ petition?');

insert into faqs (category, question, answer, keywords)
select 'certificates', 'How do I get my original certificates back from the college?', 'The court directed the college to return the original certificates of the petitioners. Collect them from the college after the court order. Carry your college ID card and any receipt the college asks for. The batch''s key person collects the hard copy of the order first.', array['certificates','original','back','collect','college','return']
where not exists (select 1 from faqs f where f.question = 'How do I get my original certificates back from the college?');

insert into faqs (category, question, answer, keywords)
select 'certificates', 'What is a no-due certificate and how do I get one?', 'A no-due certificate is a document from the college saying you owe nothing — no pending fees and no pending dues. You can request it on the platform after your fee payment is verified. The platform generates it once the college confirms there are no dues.', array['no-due','certificate','dues','fees','request']
where not exists (select 1 from faqs f where f.question = 'What is a no-due certificate and how do I get one?');

insert into faqs (category, question, answer, keywords)
select 'app-help', 'The app is stuck or blinking. How do I fix it?', 'Clear the site data in your browser settings or reinstall the app from the install page. If the problem continues, type help in the WhatsApp support chat and follow the fix guide.', array['app','stuck','blinking','fix','freeze','loading']
where not exists (select 1 from faqs f where f.question = 'The app is stuck or blinking. How do I fix it?');

insert into faqs (category, question, answer, keywords)
select 'app-help', 'I am not receiving the OTP or login link on WhatsApp. What do I do?', 'Check that the mobile number you registered with is the same number on your WhatsApp, and that WhatsApp is working. Wait two minutes, then ask the bot for a new link. The login link expires after 10 minutes, so open it as soon as it arrives.', array['otp','login','link','whatsapp','receiving','code']
where not exists (select 1 from faqs f where f.question = 'I am not receiving the OTP or login link on WhatsApp. What do I do?');

insert into faqs (category, question, answer, keywords)
select 'app-help', 'How do I install the Student Platform app on my phone?', 'Open studentplatform.dev in Chrome on your phone, tap the menu, and choose Install app or Add to Home screen. After installing, open the app from your home screen. Registration and login work only inside the installed app.', array['install','app','phone','chrome','home','screen']
where not exists (select 1 from faqs f where f.question = 'How do I install the Student Platform app on my phone?');

insert into faqs (category, question, answer, keywords)
select 'support', 'How can I contact support if I have a problem?', 'Message the Student Platform support bot on WhatsApp and type help. The bot shows common problems — app stuck, OTP not coming, number not registered, clear site data — and sends the fix for the one you tap. For money or refund problems, or a court date question, the bot passes it to the admin.', array['contact','support','help','problem','whatsapp']
where not exists (select 1 from faqs f where f.question = 'How can I contact support if I have a problem?');

insert into faqs (category, question, answer, keywords)
select 'support', 'Which colleges does the Student Platform support?', 'The platform supports students of GNIT, GNITC and BIET in Hyderabad. Each college has its own batches, and each batch has its own writ petition and case tracking.', array['colleges','support','gnit','gnitc','biet']
where not exists (select 1 from faqs f where f.question = 'Which colleges does the Student Platform support?');
