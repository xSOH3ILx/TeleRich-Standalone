import { createServer } from 'node:http';
import worker from '../public/worker.js';

createServer(async (req,res)=>{
 const response=await worker.fetch(new Request('http://127.0.0.1:4173'+req.url),{});
 res.writeHead(response.status,Object.fromEntries(response.headers));
 res.end(await response.text());
}).listen(4173,'127.0.0.1');
