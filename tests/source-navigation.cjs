const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{_electron}=require('playwright-core'),cp=require('node:child_process');
(async()=>{
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mini-source-navigation-'));const dir=path.join(temp,'Generated');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'01.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="teal"/></svg>');
const env={...process.env,MINIMANGA_DATA:path.join(temp,'data')};delete env.ELECTRON_RUN_AS_NODE;
const app=await _electron.launch({executablePath:process.env.MINIMANGA_EXE || require('electron'),args:process.env.MINIMANGA_PACKAGED ? ['--disable-gpu'] : [process.cwd(),'--disable-gpu'],env});try{
const win=await app.firstWindow();await win.getByText('故事，从这里开始').waitFor();
await app.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},dir);
await win.getByRole('button',{name:'＋ 添加目录'}).first().click();await win.waitForFunction(()=>document.querySelectorAll('.cover').length===1);
const zip=path.join(dir,'Added.zip'),link=path.join(dir,'Alias.lnk');cp.execFileSync(require('7zip-bin-full').path7z,['a','-tzip',zip,'01.svg'],{cwd:dir,windowsHide:true,stdio:'ignore'});
await app.evaluate(({shell},{link,zip})=>{shell.writeShortcutLink(link,{target:zip});shell.trashItem=async()=>{throw Error('Sidebar must not trash!')};},{link,zip});
await win.locator('.source-row > button').filter({hasText:'Generated'}).first().click();await win.locator('.source-row > button').filter({hasText:'Alias'}).first().click();
await win.waitForFunction(()=>document.querySelector('h1')?.textContent==='Alias');await win.locator('.pages button').first().click();
assert.equal(await win.locator('.reader-actions-flat .inline-stars button').count(),12);assert.equal(await win.locator('.reader-actions-flat details').count(),0);
await win.locator('.reader-actions-flat .item-actions').first().getByRole('button',{name:'4星',exact:true}).click();await win.waitForFunction(async()=>(await window.manga.favorites()).some(f=>f.rating===4));
await win.getByRole('button',{name:'Alias 移除导入',exact:true}).click();await win.waitForFunction(()=>!Array.from(document.querySelectorAll('.source-row > button')).some(b=>b.textContent?.trim()==='▥　Alias'));
await fs.access(link);await fs.access(zip);assert.equal((await win.evaluate(()=>window.manga.list())).some(b=>b.title==='Alias'),false);
console.log('PASS: late-added archive shortcut opens from tree; flat stars; sidebar removal preserves original files.');
}finally{await app.close();}})().catch(e=>{console.error(e);process.exitCode=1});
