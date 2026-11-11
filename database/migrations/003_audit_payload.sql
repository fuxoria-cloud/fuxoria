-- 保存签署的原始文本，跨TS/Go验链时不受JSON对象键顺序影响。
-- 旧记录继续按原五字段格式验证；新记录直接核对canonical_body。
ALTER TABLE audit ADD COLUMN canonical_body text;
