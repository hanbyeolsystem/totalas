-- ============================================================
-- 03_collisions.sql  (2026-05-11)
-- DB 동명충돌 24그룹: 자식 데이터 customer_id 재배치 → 잉여 archive
-- 자식 테이블: rental_printers, rental_contracts, rental_meetings, rental_archive
-- ============================================================
BEGIN;

-- [신독엔지니어링]  primary=c_0290, archive=['c_0011']
UPDATE rental_printers  SET customer_id = 'c_0290' WHERE customer_id IN ('c_0011');
UPDATE rental_contracts SET customer_id = 'c_0290' WHERE customer_id IN ('c_0011');
UPDATE rental_meetings  SET customer_id = 'c_0290' WHERE customer_id IN ('c_0011');
UPDATE rental_archive   SET customer_id = 'c_0290' WHERE customer_id IN ('c_0011');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0290'
 WHERE id IN ('c_0011');

-- [신독엔지니어링2층]  primary=c_0016, archive=['c_0015', 'c_0012', 'c_0017', 'c_0013']
UPDATE rental_printers  SET customer_id = 'c_0016' WHERE customer_id IN ('c_0015', 'c_0012', 'c_0017', 'c_0013');
UPDATE rental_contracts SET customer_id = 'c_0016' WHERE customer_id IN ('c_0015', 'c_0012', 'c_0017', 'c_0013');
UPDATE rental_meetings  SET customer_id = 'c_0016' WHERE customer_id IN ('c_0015', 'c_0012', 'c_0017', 'c_0013');
UPDATE rental_archive   SET customer_id = 'c_0016' WHERE customer_id IN ('c_0015', 'c_0012', 'c_0017', 'c_0013');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0016'
 WHERE id IN ('c_0015', 'c_0012', 'c_0017', 'c_0013');

-- [고문당인쇄(아코스코리아)]  primary=c_0024, archive=['c_0023']
UPDATE rental_printers  SET customer_id = 'c_0024' WHERE customer_id IN ('c_0023');
UPDATE rental_contracts SET customer_id = 'c_0024' WHERE customer_id IN ('c_0023');
UPDATE rental_meetings  SET customer_id = 'c_0024' WHERE customer_id IN ('c_0023');
UPDATE rental_archive   SET customer_id = 'c_0024' WHERE customer_id IN ('c_0023');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0024'
 WHERE id IN ('c_0023');

-- [일광특수강]  primary=c_0306, archive=['c_0026']
UPDATE rental_printers  SET customer_id = 'c_0306' WHERE customer_id IN ('c_0026');
UPDATE rental_contracts SET customer_id = 'c_0306' WHERE customer_id IN ('c_0026');
UPDATE rental_meetings  SET customer_id = 'c_0306' WHERE customer_id IN ('c_0026');
UPDATE rental_archive   SET customer_id = 'c_0306' WHERE customer_id IN ('c_0026');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0306'
 WHERE id IN ('c_0026');

-- [에코프랜즈]  primary=c_0028, archive=['c_0027']
UPDATE rental_printers  SET customer_id = 'c_0028' WHERE customer_id IN ('c_0027');
UPDATE rental_contracts SET customer_id = 'c_0028' WHERE customer_id IN ('c_0027');
UPDATE rental_meetings  SET customer_id = 'c_0028' WHERE customer_id IN ('c_0027');
UPDATE rental_archive   SET customer_id = 'c_0028' WHERE customer_id IN ('c_0027');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0028'
 WHERE id IN ('c_0027');

-- [화진기공사]  primary=c_0275, archive=['c_0032', 'c_0031']
UPDATE rental_printers  SET customer_id = 'c_0275' WHERE customer_id IN ('c_0032', 'c_0031');
UPDATE rental_contracts SET customer_id = 'c_0275' WHERE customer_id IN ('c_0032', 'c_0031');
UPDATE rental_meetings  SET customer_id = 'c_0275' WHERE customer_id IN ('c_0032', 'c_0031');
UPDATE rental_archive   SET customer_id = 'c_0275' WHERE customer_id IN ('c_0032', 'c_0031');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0275'
 WHERE id IN ('c_0032', 'c_0031');

-- [금영정공]  primary=c_0067, archive=['c_0066', 'c_0065', 'c_0064', 'c_0063', 'c_0062', 'c_0061']
UPDATE rental_printers  SET customer_id = 'c_0067' WHERE customer_id IN ('c_0066', 'c_0065', 'c_0064', 'c_0063', 'c_0062', 'c_0061');
UPDATE rental_contracts SET customer_id = 'c_0067' WHERE customer_id IN ('c_0066', 'c_0065', 'c_0064', 'c_0063', 'c_0062', 'c_0061');
UPDATE rental_meetings  SET customer_id = 'c_0067' WHERE customer_id IN ('c_0066', 'c_0065', 'c_0064', 'c_0063', 'c_0062', 'c_0061');
UPDATE rental_archive   SET customer_id = 'c_0067' WHERE customer_id IN ('c_0066', 'c_0065', 'c_0064', 'c_0063', 'c_0062', 'c_0061');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0067'
 WHERE id IN ('c_0066', 'c_0065', 'c_0064', 'c_0063', 'c_0062', 'c_0061');

-- [경진기계]  primary=c_0070, archive=['c_0069', 'c_0068']
UPDATE rental_printers  SET customer_id = 'c_0070' WHERE customer_id IN ('c_0069', 'c_0068');
UPDATE rental_contracts SET customer_id = 'c_0070' WHERE customer_id IN ('c_0069', 'c_0068');
UPDATE rental_meetings  SET customer_id = 'c_0070' WHERE customer_id IN ('c_0069', 'c_0068');
UPDATE rental_archive   SET customer_id = 'c_0070' WHERE customer_id IN ('c_0069', 'c_0068');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0070'
 WHERE id IN ('c_0069', 'c_0068');

-- [엠에이텍]  primary=c_0073, archive=['c_0072']
UPDATE rental_printers  SET customer_id = 'c_0073' WHERE customer_id IN ('c_0072');
UPDATE rental_contracts SET customer_id = 'c_0073' WHERE customer_id IN ('c_0072');
UPDATE rental_meetings  SET customer_id = 'c_0073' WHERE customer_id IN ('c_0072');
UPDATE rental_archive   SET customer_id = 'c_0073' WHERE customer_id IN ('c_0072');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0073'
 WHERE id IN ('c_0072');

-- [극동볼트(1층)]  primary=c_0082, archive=['c_0089', 'c_0088', 'c_0086']
UPDATE rental_printers  SET customer_id = 'c_0082' WHERE customer_id IN ('c_0089', 'c_0088', 'c_0086');
UPDATE rental_contracts SET customer_id = 'c_0082' WHERE customer_id IN ('c_0089', 'c_0088', 'c_0086');
UPDATE rental_meetings  SET customer_id = 'c_0082' WHERE customer_id IN ('c_0089', 'c_0088', 'c_0086');
UPDATE rental_archive   SET customer_id = 'c_0082' WHERE customer_id IN ('c_0089', 'c_0088', 'c_0086');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0082'
 WHERE id IN ('c_0089', 'c_0088', 'c_0086');

-- [극동볼트(2층)]  primary=c_0084, archive=['c_0087']
UPDATE rental_printers  SET customer_id = 'c_0084' WHERE customer_id IN ('c_0087');
UPDATE rental_contracts SET customer_id = 'c_0084' WHERE customer_id IN ('c_0087');
UPDATE rental_meetings  SET customer_id = 'c_0084' WHERE customer_id IN ('c_0087');
UPDATE rental_archive   SET customer_id = 'c_0084' WHERE customer_id IN ('c_0087');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0084'
 WHERE id IN ('c_0087');

-- [한미툴링]  primary=c_0279, archive=['c_0113']
UPDATE rental_printers  SET customer_id = 'c_0279' WHERE customer_id IN ('c_0113');
UPDATE rental_contracts SET customer_id = 'c_0279' WHERE customer_id IN ('c_0113');
UPDATE rental_meetings  SET customer_id = 'c_0279' WHERE customer_id IN ('c_0113');
UPDATE rental_archive   SET customer_id = 'c_0279' WHERE customer_id IN ('c_0113');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0279'
 WHERE id IN ('c_0113');

-- [우진레이저]  primary=c_0272, archive=['c_0260', 'c_0115']
UPDATE rental_printers  SET customer_id = 'c_0272' WHERE customer_id IN ('c_0260', 'c_0115');
UPDATE rental_contracts SET customer_id = 'c_0272' WHERE customer_id IN ('c_0260', 'c_0115');
UPDATE rental_meetings  SET customer_id = 'c_0272' WHERE customer_id IN ('c_0260', 'c_0115');
UPDATE rental_archive   SET customer_id = 'c_0272' WHERE customer_id IN ('c_0260', 'c_0115');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0272'
 WHERE id IN ('c_0260', 'c_0115');

-- [유승산업]  primary=c_0298, archive=['c_0117', 'c_0116']
UPDATE rental_printers  SET customer_id = 'c_0298' WHERE customer_id IN ('c_0117', 'c_0116');
UPDATE rental_contracts SET customer_id = 'c_0298' WHERE customer_id IN ('c_0117', 'c_0116');
UPDATE rental_meetings  SET customer_id = 'c_0298' WHERE customer_id IN ('c_0117', 'c_0116');
UPDATE rental_archive   SET customer_id = 'c_0298' WHERE customer_id IN ('c_0117', 'c_0116');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0298'
 WHERE id IN ('c_0117', 'c_0116');

-- [프린텍]  primary=c_0301, archive=['c_0119']
UPDATE rental_printers  SET customer_id = 'c_0301' WHERE customer_id IN ('c_0119');
UPDATE rental_contracts SET customer_id = 'c_0301' WHERE customer_id IN ('c_0119');
UPDATE rental_meetings  SET customer_id = 'c_0301' WHERE customer_id IN ('c_0119');
UPDATE rental_archive   SET customer_id = 'c_0301' WHERE customer_id IN ('c_0119');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0301'
 WHERE id IN ('c_0119');

-- [화진교역]  primary=c_0304, archive=['c_0120']
UPDATE rental_printers  SET customer_id = 'c_0304' WHERE customer_id IN ('c_0120');
UPDATE rental_contracts SET customer_id = 'c_0304' WHERE customer_id IN ('c_0120');
UPDATE rental_meetings  SET customer_id = 'c_0304' WHERE customer_id IN ('c_0120');
UPDATE rental_archive   SET customer_id = 'c_0304' WHERE customer_id IN ('c_0120');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0304'
 WHERE id IN ('c_0120');

-- [송원이앤지]  primary=c_0130, archive=['c_0129']
UPDATE rental_printers  SET customer_id = 'c_0130' WHERE customer_id IN ('c_0129');
UPDATE rental_contracts SET customer_id = 'c_0130' WHERE customer_id IN ('c_0129');
UPDATE rental_meetings  SET customer_id = 'c_0130' WHERE customer_id IN ('c_0129');
UPDATE rental_archive   SET customer_id = 'c_0130' WHERE customer_id IN ('c_0129');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0130'
 WHERE id IN ('c_0129');

-- [에스엠영상의학과의원]  primary=c_0255, archive=['c_0152']
UPDATE rental_printers  SET customer_id = 'c_0255' WHERE customer_id IN ('c_0152');
UPDATE rental_contracts SET customer_id = 'c_0255' WHERE customer_id IN ('c_0152');
UPDATE rental_meetings  SET customer_id = 'c_0255' WHERE customer_id IN ('c_0152');
UPDATE rental_archive   SET customer_id = 'c_0255' WHERE customer_id IN ('c_0152');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0255'
 WHERE id IN ('c_0152');

-- [장준석세무사]  primary=c_0308, archive=['c_0197']
UPDATE rental_printers  SET customer_id = 'c_0308' WHERE customer_id IN ('c_0197');
UPDATE rental_contracts SET customer_id = 'c_0308' WHERE customer_id IN ('c_0197');
UPDATE rental_meetings  SET customer_id = 'c_0308' WHERE customer_id IN ('c_0197');
UPDATE rental_archive   SET customer_id = 'c_0308' WHERE customer_id IN ('c_0197');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0308'
 WHERE id IN ('c_0197');

-- [진영준bni]  primary=c_0310, archive=['c_0212']
UPDATE rental_printers  SET customer_id = 'c_0310' WHERE customer_id IN ('c_0212');
UPDATE rental_contracts SET customer_id = 'c_0310' WHERE customer_id IN ('c_0212');
UPDATE rental_meetings  SET customer_id = 'c_0310' WHERE customer_id IN ('c_0212');
UPDATE rental_archive   SET customer_id = 'c_0310' WHERE customer_id IN ('c_0212');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0310'
 WHERE id IN ('c_0212');

-- [이끌림]  primary=c_0311, archive=['c_0220']
UPDATE rental_printers  SET customer_id = 'c_0311' WHERE customer_id IN ('c_0220');
UPDATE rental_contracts SET customer_id = 'c_0311' WHERE customer_id IN ('c_0220');
UPDATE rental_meetings  SET customer_id = 'c_0311' WHERE customer_id IN ('c_0220');
UPDATE rental_archive   SET customer_id = 'c_0311' WHERE customer_id IN ('c_0220');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0311'
 WHERE id IN ('c_0220');

-- [대한바디솔루션협회(김동겸)]  primary=c_0312, archive=['c_0223']
UPDATE rental_printers  SET customer_id = 'c_0312' WHERE customer_id IN ('c_0223');
UPDATE rental_contracts SET customer_id = 'c_0312' WHERE customer_id IN ('c_0223');
UPDATE rental_meetings  SET customer_id = 'c_0312' WHERE customer_id IN ('c_0223');
UPDATE rental_archive   SET customer_id = 'c_0312' WHERE customer_id IN ('c_0223');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0312'
 WHERE id IN ('c_0223');

-- [효선장례서비스]  primary=c_0313, archive=['c_0224']
UPDATE rental_printers  SET customer_id = 'c_0313' WHERE customer_id IN ('c_0224');
UPDATE rental_contracts SET customer_id = 'c_0313' WHERE customer_id IN ('c_0224');
UPDATE rental_meetings  SET customer_id = 'c_0313' WHERE customer_id IN ('c_0224');
UPDATE rental_archive   SET customer_id = 'c_0313' WHERE customer_id IN ('c_0224');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0313'
 WHERE id IN ('c_0224');

-- [리포브(김은혜)]  primary=c_0317, archive=['c_0248']
UPDATE rental_printers  SET customer_id = 'c_0317' WHERE customer_id IN ('c_0248');
UPDATE rental_contracts SET customer_id = 'c_0317' WHERE customer_id IN ('c_0248');
UPDATE rental_meetings  SET customer_id = 'c_0317' WHERE customer_id IN ('c_0248');
UPDATE rental_archive   SET customer_id = 'c_0317' WHERE customer_id IN ('c_0248');
UPDATE rental_customers SET archived_at = NOW(),
       archived_reason = '동명충돌 통합 (2026-05-11) primary=c_0317'
 WHERE id IN ('c_0248');

-- 총 archive 대상: 38건
COMMIT;

-- 검증
SELECT id, company, archived_reason FROM rental_customers
 WHERE id IN ('c_0011', 'c_0015', 'c_0012', 'c_0017', 'c_0013', 'c_0023', 'c_0026', 'c_0027', 'c_0032', 'c_0031')
 ORDER BY id;