-- 同一服务同时只允许一个运行中动作；守护进程和管理员都受此约束。
CREATE UNIQUE INDEX jobs_one_running_per_service ON jobs(service_id) WHERE state='running';
