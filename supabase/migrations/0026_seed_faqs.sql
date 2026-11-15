-- Migrates the FAQ list that used to be hardcoded in src/components/FAQModal.tsx
-- into the database. Content unchanged; keywords are new, derived from each
-- question for initial keyword-match search.

insert into faqs (category, question, answer, keywords) values
('process', 'What is the process?',
 E'1. Join the batch.\n2. Submit the required details.\n3. Advocate files the case.\n4. High Court order is obtained.\n5. The Court order/notice is sent to the college.\n6. After the college receives it, students in that petition can collect their original certificates by carrying the court order copy.',
 array['process','steps','procedure','petition','works','how']),

('process', 'How long does it take?',
 'It depends on the High Court schedule. Sometimes the order may be obtained in around 10 days, but no fixed timeline can be guaranteed.',
 array['time','long','duration','days','timeline','when']),

('legal', 'Is this legal?',
 'Yes. The petition is filed through an advocate before the High Court.',
 array['legal','lawful','advocate','court','valid']),

('certificates', 'Will I get my certificates?',
 'If the High Court allows the petition and the college complies with the order, your original certificates will be released.',
 array['certificate','certificates','original','get','release']),

('eligibility', 'I have a job offer or higher studies. Can I join?',
 'Yes. If you need your certificates urgently, joining the earliest available batch is recommended.',
 array['job','offer','studies','urgent','higher']),

('eligibility', 'Can I join later?',
 'Yes, but later batches may take longer to fill. If your certificates are urgent, join an earlier batch.',
 array['later','join','delay','wait']),

('privacy', 'Will my personal details be safe?',
 'Yes. Your details are used only for preparing the court petition and related legal documentation.',
 array['safe','privacy','details','data','personal','secure']),

('process', 'Can I leave after joining?',
 'Please confirm only if you are sure. Once the batch is finalized and legal work begins, changes are difficult.',
 array['leave','quit','withdraw','exit','cancel']);
