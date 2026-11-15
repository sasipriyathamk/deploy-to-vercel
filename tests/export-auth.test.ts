import {it,expect,vi,afterEach} from 'vitest';
import {GET} from '@/app/api/export/route';
afterEach(()=>vi.unstubAllEnvs());
it('requires export authentication even when no secret is configured',async()=>{
 vi.stubEnv('EXPORT_SECRET','');vi.stubEnv('CRON_SECRET','');
 expect((await GET(new Request('http://localhost/api/export'))).status).toBe(401);
});
it('rejects invalid keys without opening the database',async()=>{
 vi.stubEnv('EXPORT_SECRET','export-only');vi.stubEnv('CRON_SECRET','cron-only');
 for(const key of ['','Bearer bad','Bearer cron-only']){
  expect((await GET(new Request('http://localhost/api/export',{headers:{authorization:key}}))).status).toBe(401);
 }
});
