import { it,expect,vi,afterEach } from 'vitest';
import {pollJson,cachedPoll} from '@/lib/polling';
afterEach(()=>vi.unstubAllGlobals());
it('shares overlapping requests and retains the previous response when the server fails',async()=>{
 let resolve!:(value:Response)=>void;
 const fetcher=vi.fn().mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r;})).mockResolvedValueOnce(Response.json({error:'offline'},{status:503}));
 vi.stubGlobal('fetch',fetcher);
 const first=pollJson('/test/shared');const second=pollJson('/test/shared');
 resolve(Response.json({price:null}));
 expect(await first).toEqual({price:null});expect(await second).toEqual({price:null});expect(fetcher).toHaveBeenCalledTimes(1);
 await expect(pollJson('/test/shared')).rejects.toThrow('offline');
 expect(cachedPoll('/test/shared')).toEqual({price:null});
 expect(cachedPoll('/test/different')).toBeNull();
});
