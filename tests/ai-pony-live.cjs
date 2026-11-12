const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),sharp=require('sharp');
const {_electron}=require('playwright-core');
if(process.env.MINIMANGA_LIVE_AI!=='1') {console.log('Set MINIMANGA_LIVE_AI=1; local ComfyUI + Pony resources required.');process.exit(0);}
(async()=>{
 const root=process.cwd(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'mini-manga-pony-live-')),data=path.join(temp,'data'),source=path.join(temp,'Generated cartoon');
 await fs.mkdir(source);await fs.mkdir(path.join(data,'ai'),{recursive:true});await fs.cp(path.join(root,'resources/ai'),path.join(data,'ai'),{recursive:true});
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="896"><rect width="640" height="896" fill="#e6f0e2"/><g stroke="#293444" stroke-width="7" stroke-linejoin="round"><path d="M170 800L190 460Q205 380 320 380Q435 380 450 460L470 800Z" fill="#cc3434"/><path d="M300 400L320 440L340 400M320 440V800" fill="none"/><path d="M190 460L150 750L190 765L235 520M450 460L490 750L450 765L405 520" fill="#cc3434"/><path d="M285 360V410Q320 450 355 410V360" fill="#efc2a2"/><ellipse cx="320" cy="250" rx="100" ry="135" fill="#efc2a2"/><path d="M220 260Q190 90 320 95Q460 100 420 260L385 190L340 210L315 170L250 220Z" fill="#293444"/><path d="M255 260Q275 245 295 260M345 260Q365 245 385 260M295 325Q320 340 345 325" fill="none"/></g></svg>';
 const original=await sharp(Buffer.from(svg)).png().toBuffer(),file=path.join(source,'01.png');await fs.writeFile(file,original);
 const mask=await sharp({create:{width:640,height:896,channels:3,background:'black'}}).composite([{input:await sharp({create:{width:340,height:400,channels:3,background:'white'}}).png().toBuffer(),left:150,top:400}]).png().toBuffer();
 const env={...process.env,MINIMANGA_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:process.env.MINIMANGA_EXE||require('electron'),args:process.env.MINIMANGA_PACKAGED?['--disable-gpu']:[root,'--disable-gpu'],env});
 try{
 const win=await app.firstWindow();await win.getByText('故事，从这里开始').waitFor();
 await app.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});},source);
 await win.getByRole('button',{name:'＋ 添加目录'}).first().click();await win.locator('.book-card').first().waitFor();
 const books=await win.evaluate(()=>window.manga.list()),book=books.find(b=>b.title==='Generated cartoon');
 let r=await win.evaluate(({id,mask})=>window.manga.aiStart(id,0,'solo, adult man, blue jacket, long sleeves, zipper, cartoon, simple background','pony-sdxl',{mask}),{id:book.id,mask:'data:image/png;base64,'+mask.toString('base64')});
 console.log('Pony submitted',r.id);
 const deadline=Date.now()+20*60*1000;
 while(r.status==='generating'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,2000));r=await win.evaluate(id=>window.manga.aiGet(id),r.id);}
 assert.equal(r.status,'ready',r.error);r=await win.evaluate(id=>window.manga.aiSave(id),r.id);
 const before=await sharp(original).removeAlpha().raw().toBuffer(),after=await sharp(r.savedPath).removeAlpha().raw().toBuffer();let changed=0;
 for(let y=0;y<896;y++)for(let x=0;x<640;x++)for(let c=0;c<3;c++){const i=(y*640+x)*3+c;if(x<150||x>=490||y<400||y>=800)assert.equal(before[i],after[i]);else if(before[i]!==after[i])changed++;}
 assert.ok(changed>0);assert.deepEqual(await fs.readFile(file),original);
 await win.getByRole('button',{name:'✦　AI修改记录',exact:true}).click();await win.getByRole('button',{name:'查看结果 / 操作'}).first().click();await win.waitForFunction(()=>document.querySelector('.ai-result img')?.naturalWidth>0);
 await win.screenshot({path:path.join(root,'.tools/ai-pony-live.png'),mask:[win.locator('.ai-saved-path')],maskColor:'#202938'});await fs.copyFile(file,path.join(root,'.tools/pony-original.png'));await fs.copyFile(r.savedPath,path.join(root,'.tools/pony-result.png'));
 const result={status:'passed',seconds:r.seconds,source:'generated clothed cartoon',outsideMaskUnchanged:true,originalBytesUnchanged:true,changedChannels:changed,profile:r.profileName,output:r.savedPath};
 await fs.writeFile(path.join(root,'.tools/ai-pony-live-validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
