-- 到期调度：只扫描仍active且已设置到期时间的服务，支持按到期时间和ID有界领取。
-- 执行：npm run db:migrate；此索引不改变资源或任务状态。
CREATE INDEX services_active_due ON services(due_at,id) WHERE status='active' AND due_at IS NOT NULL;
