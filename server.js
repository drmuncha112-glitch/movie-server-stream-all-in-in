const { execSync } = require("child_process")

const JELLYFIN_URL="http://192.168.2.191:8096";
const JELLYFIN_API_KEY="8d96cf718fde43c5b541f923a621facb";

const WebTorrent=require("webtorrent");
const client=new WebTorrent({
tracker:true,
dht:true,
webSeeds:true,
torrentPort:0,
path:"/tmp/webtorrent"
});

client.on("error", console.error)

const express=require("express");
const http=require("http");
const axios=require("axios");
const fs=require("fs");
const path=require("path");
const net=require("net");

const app=express();
app.use(express.json());
app.use(express.static("public"));

const LOCAL_IP="192.168.2.191";
const TMDB_KEY="000b66b2037f4871c5d0ff070b44d730";

const JACKETT_URL="http://192.168.2.191:9117/api/v2.0/indexers/all/results";
const JACKETT_API="796uy8kdo2fpowsdn87duzsktrfuvze9";

const MOVIES_DIR="/Users/raghavchandra/gdrive/movies";
const SHOWS_DIR="/Users/raghavchandra/gdrive/shows";
const GDRIVE_MOUNT="/Users/raghavchandra/gdrive"

const CACHE_DIR="/tmp/jellystream-cache";
const FALLBACK_CACHE="/private/tmp/webtorrent-cache";
const WEBTORRENT_DIR="/tmp/webtorrent";
const STATE_FILE="/Users/raghavchandra/torrent-jellyfin/state.json";

if(!fs.existsSync(CACHE_DIR))fs.mkdirSync(CACHE_DIR,{recursive:true});
if(!fs.existsSync(WEBTORRENT_DIR))fs.mkdirSync(WEBTORRENT_DIR,{recursive:true});

const activePorts=new Set();
const movieRegistry={};
const streamActivity={}
const sessionFolders = new Set()

/* =========================================
   SLEEP / WAKE DETECTOR
   Sleep → pause all torrents, clear disk cache, free ports, save state
   Wake  → restore saved state, re-add all torrents, rebuild buffers
=========================================  */

let lastTick = Date.now()
let isSleeping = false

setInterval(async()=>{

const now = Date.now()
const diff = now - lastTick
lastTick = now

if(diff > 120000 && !isSleeping){
  // System just went to sleep (interval was frozen)
  isSleeping = true
  console.log("SLEEP DETECTED — pausing torrents, clearing cache, saving state")

  for(const k in movieRegistry){
    const entry = movieRegistry[k]
    if(entry.bufferCheck){ clearInterval(entry.bufferCheck); entry.bufferCheck=null }
    try{ entry.torrent.pause(); entry.paused=true }catch(e){}
    if(entry.diskPath) deleteDiskCache(entry.diskPath)
    entry.diskPath=null
    if(entry.server){ try{entry.server.close()}catch(e){}; entry.server=null }
    activePorts.delete(entry.port)
  }

  saveState()
  console.log("SLEEP PREP DONE — state saved to", STATE_FILE)

} else if(diff <= 120000 && isSleeping){
  // First normal tick after sleep = wake
  isSleeping = false
  console.log("WAKE DETECTED — restoring streams from state")

  const saved = loadState()
  if(saved.length === 0){ console.log("Nothing to restore"); return }

  // Clean stale registry before restoring
  for(const k in movieRegistry){ try{movieRegistry[k].torrent.destroy()}catch(e){}; delete movieRegistry[k] }
  activePorts.clear()

  for(const {magnet,title,year} of saved){
    console.log("RESTORING →", title, year)
    // Re-post to /add which handles everything cleanly
    await axios.post("http://localhost:3000/add",{magnet,title,year}).catch((e)=>{
      console.log("RESTORE FAILED:", title, e.message)
    })
  }
}

},30000)

/* =========================================
   GOOGLE DRIVE AUTO RECOVERY
========================================= */

function mountDrive(){

try{

console.log("Checking Google Drive mount...")

const mounts=execSync("mount").toString()

if(mounts.includes(GDRIVE_MOUNT)){
console.log("✓ GDrive already mounted")
return
}

console.log("GDrive not mounted")

if(fs.existsSync(GDRIVE_MOUNT)){

const files=fs.readdirSync(GDRIVE_MOUNT)

if(files.length>0){

console.log("Ghost mount detected — cleaning mount folder")

for(const f of files){

fs.rmSync(path.join(GDRIVE_MOUNT,f),{
recursive:true,
force:true
})

}

}

}

console.log("Mounting Google Drive...")

execSync(`rclone mount gdrive: ${GDRIVE_MOUNT} \
--vfs-cache-mode full \
--buffer-size 256M \
--vfs-read-chunk-size 64M \
--vfs-read-chunk-size-limit 1G \
--dir-cache-time 12h \
--poll-interval 1m \
--daemon`)

console.log("✓ Google Drive mounted")

console.log("Restarting Jellyfin container so Docker sees the mount...")

execSync("docker restart jellyfin")

}catch(e){

console.log("Mount process failed:",e.message)

}

}

/* =========================================
   CACHE CLEANER
========================================= */

function cleanCache(){

try{

if(fs.existsSync(CACHE_DIR)){

for(const f of fs.readdirSync(CACHE_DIR)){

fs.rmSync(path.join(CACHE_DIR,f),{
recursive:true,
force:true
})

}

}

if(fs.existsSync(FALLBACK_CACHE)){

for(const f of fs.readdirSync(FALLBACK_CACHE)){

fs.rmSync(path.join(FALLBACK_CACHE,f),{
recursive:true,
force:true
})

}

}


}catch(e){}

}


/* =========================================
   STATE PERSISTENCE
========================================= */

function saveState(){
  try{
    const entries = Object.values(movieRegistry).map(r=>({magnet:r.magnet,title:r.title,year:r.year}))
    fs.writeFileSync(STATE_FILE, JSON.stringify(entries,null,2))
  }catch(e){ console.log('STATE SAVE FAILED:',e.message) }
}

function loadState(){
  try{
    if(!fs.existsSync(STATE_FILE)) return []
    return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))
  }catch(e){ return [] }
}

function clearState(){
  try{ if(fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE) }catch(e){}
}

/* =========================================
   DISK CACHE HELPERS
========================================= */

function deleteDiskCache(diskPath){
  if(!diskPath) return
  try{
    const rel = require('path').relative(WEBTORRENT_DIR, diskPath)
    const top = rel.split(require('path').sep)[0]
    const target = require('path').join(WEBTORRENT_DIR, top)
    if(fs.existsSync(target)){ fs.rmSync(target,{recursive:true,force:true}); console.log('DISK CACHE DELETED → '+top) }
  }catch(e){}
}

// When a movie starts playing, immediately pause all others + wipe their disk cache
function onPlaybackStarted(activeKey){
  for(const k in movieRegistry){
    if(k===activeKey) continue
    const entry = movieRegistry[k]
    if(entry.bufferCheck){ clearInterval(entry.bufferCheck); entry.bufferCheck=null }
    if(entry.server){ try{entry.server.close()}catch(e){}; entry.server=null }
    deleteDiskCache(entry.diskPath)
    entry.diskPath=null
    try{ entry.torrent.pause(); entry.paused=true; console.log('PAUSED → '+k) }catch(e){}
  }
}

/* =========================================
   PORT FINDER
========================================= */

function getFreePort(start=9000){

return new Promise(resolve=>{

const tryPort=(p)=>{

if(activePorts.has(p))return tryPort(p+1)

const server=net.createServer()

server.once("error",()=>tryPort(p+1))

server.once("listening",()=>{
server.close(()=>resolve(p))
})

server.listen(p)

}

tryPort(start)

})

}

/* =========================================
   TORRENT RANKING
========================================= */

function rankTorrents(list){

function score(name){

name=name.toLowerCase()

if(name.includes("2160")&&name.includes("dv"))return 140
if(name.includes("2160")&&name.includes("hdr"))return 130
if(name.includes("2160")&&name.includes("hdr10"))return 125
if(name.includes("2160")&&name.includes("web"))return 120
if(name.includes("2160")&&name.includes("bluray"))return 115
if(name.includes("2160")&&name.includes("remux"))return 110

if(name.includes("1080")&&name.includes("hdr"))return 90
if(name.includes("1080")&&name.includes("web"))return 80
if(name.includes("1080")&&name.includes("bluray"))return 70

return 10

}

return list.sort((a,b)=>{

const qa=score(a.title)
const qb=score(b.title)

if(qa!==qb)return qb-qa

return b.seeds-a.seeds

})

}

/* =========================================
   SUBTITLES
========================================= */

async function downloadSubtitle(title,year,folder){

try{

const query=`${title} ${year}`

const search=await axios.get(
`https://subdl.com/search?q=${encodeURIComponent(query)}`,
{timeout:10000}
)

const match=search.data.match(/\/subtitle\/.*?\.srt/)

if(!match){
console.log("No subtitle found")
return
}

const url=`https://subdl.com${match[0]}`

const file=await axios.get(url,{responseType:"arraybuffer"})

const subtitlePath=path.join(folder,`${title} (${year}).eng.srt`)

fs.writeFileSync(subtitlePath,file.data)

console.log("SUBTITLE DOWNLOADED")

}catch(e){

console.log("SUBTITLE SEARCH FAILED")

}

}

/* =========================================
   MOVIE SEARCH
========================================= */

app.get("/movies",async(req,res)=>{

try{

const r=await axios.get(
`https://api.themoviedb.org/3/search/movie`,
{
params:{
api_key:TMDB_KEY,
query:req.query.q
}
})

res.json(
r.data.results.map(m=>({
id:m.id,
title:m.title,
year:(m.release_date||"").split("-")[0],
poster:m.poster_path
})).slice(0,10)
)

}catch(e){

res.status(500).send("TMDB failed")

}

})

/* =========================================
   TV SHOW SEARCH
========================================= */

app.get("/shows",async(req,res)=>{

try{

const r=await axios.get(
`https://api.themoviedb.org/3/search/tv`,
{
params:{
api_key:TMDB_KEY,
query:req.query.q
}
})

res.json(
r.data.results.map(s=>({
id:s.id,
title:s.name,
year:(s.first_air_date||"").split("-")[0],
poster:s.poster_path
})).slice(0,10)
)

}catch(e){

res.status(500).send("TMDB TV failed")

}

})

/* =========================================
   TORRENT SEARCH
========================================= */

app.get("/torrents",async(req,res)=>{

try{

const movie=await axios.get(
`https://api.themoviedb.org/3/movie/${req.query.tmdb}`,
{params:{api_key:TMDB_KEY}}
)

const query=`${movie.data.title} ${(movie.data.release_date||"").split("-")[0]}`

const r=await axios.get(
JACKETT_URL,
{
params:{
apikey:JACKETT_API,
Query:query,
Category:2000
}
})

let list=r.data.Results.map(t=>({

title:t.Title,
seeds:t.Seeders,
peers:t.Peers||0,
size:(t.Size/1073741824).toFixed(2)+" GB",
magnet:t.MagnetUri||(t.Link?.startsWith("magnet:")?t.Link:null)

}))
.filter(t=>t.seeds>=15 && t.magnet)

res.json(rankTorrents(list).slice(0,30))

}catch(e){

console.log("Jackett error:",e.message)

res.status(500).send("Jackett failed")

}

})

/* =========================================
   STREAM CREATION
========================================= */

app.post("/add",async(req,res)=>{

const{magnet,title,year}=req.body

console.log("\n========== ADD STREAM ==========")
console.log("TITLE:",title)

const key=`${title}-${year}`

let port

if(movieRegistry[key]){

console.log("REPLACING TORRENT")

const old=movieRegistry[key]

try{
old.torrent.destroy({destroyStore:true})
}catch{}

if(old.server){
try{
await new Promise(resolve=>{
old.server.close(()=>resolve())
})
}catch{}
}

cleanCache()

port=old.port

}else{

port=await getFreePort()

activePorts.add(port)

}

let torrent

try{
 torrent = client.add(magnet)
}catch(e){
 console.log("TORRENT ADD FAILED")
 return res.status(500).json({error:"torrent failed"})
}

setTimeout(()=>{
if(!torrent.ready){
console.log("TORRENT METADATA TIMEOUT")
try{torrent.destroy()}catch{}
}
},20000)

movieRegistry[key]={torrent,port,server:null,lastAccess:Date.now(),diskPath:null,total:null,bufferCheck:null,paused:false,magnet,title,year}

torrent.on("ready",async()=>{

console.log("TORRENT READY →", title)

const videoExt=[".mkv",".mp4",".avi",".mov",".webm"]

const file=torrent.files
.filter(f=>videoExt.some(ext=>f.name.toLowerCase().endsWith(ext)))
.filter(f=>!f.name.toLowerCase().includes("sample"))
.sort((a,b)=>b.length-a.length)[0]

if(!file){
console.log("No video file found in torrent")
return
}

torrent.select(file._startPiece,file._endPiece,true)
torrent.critical(file._startPiece,file._startPiece+120)

const folder=path.join(MOVIES_DIR,`${title} (${year})`)
sessionFolders.add(folder)
if(!fs.existsSync(folder)) fs.mkdirSync(folder,{recursive:true})

const strmPath=path.join(folder,`${title} (${year}).strm`)
if(fs.existsSync(strmPath)) fs.rmSync(strmPath)

fs.writeFileSync(
  strmPath,
  `http://${LOCAL_IP}:${port}/stream\n`
)

axios.post(
  `${JELLYFIN_URL}/Library/Refresh`,
  {},
  {params:{api_key:JELLYFIN_API_KEY}}
).catch(()=>{})
const diskPath=path.join(WEBTORRENT_DIR,file.path)

movieRegistry[key].diskPath=diskPath
movieRegistry[key].total=file.length

const ext=path.extname(file.name).toLowerCase()
let contentType="video/mp4"
if(ext===".mkv") contentType="video/x-matroska"
if(ext===".avi") contentType="video/x-msvideo"
if(ext===".mov") contentType="video/quicktime"
if(ext===".webm") contentType="video/webm"

const total=file.length


const server=http.createServer((req,res)=>{

  if(!req.url.startsWith("/stream")){
    res.writeHead(404); return res.end()
  }

  if(movieRegistry[key]) movieRegistry[key].lastAccess=Date.now()

  const rawRange=req.headers.range||""

  const isProbe=(()=>{
  if(!rawRange) return true
  const m=rawRange.match(/bytes=(\d+)-(\d*)/)
  if(!m) return true

  const s=parseInt(m[1],10)
  const e=m[2]!==""?parseInt(m[2],10):null

  // tiny reads = metadata probe
  if(s < 200000) return true

  return false
})()

  let start=0
  let end=total-1

  if(rawRange){
    const m=rawRange.match(/bytes=(\d+)-(\d*)/)
    if(m){
      start=parseInt(m[1],10)||0
      end=m[2]!==""?parseInt(m[2],10):total-1
    }
  }

  if(start<0) start=0
  if(start>=total) start=0
  if(end>=total) end=total-1
  if(end<start) end=total-1

  const chunk=(end-start)+1

  const headers={
    "Accept-Ranges":"bytes",
    "Content-Length":chunk,
    "Content-Type":contentType,
    "Content-Range":`bytes ${start}-${end}/${total}`
  }

  if(!isProbe&&!streamActivity[key]){
    console.log(`PLAYBACK STARTED → ${title} (range: ${start}-${end})`)
    streamActivity[key]=true
    onPlaybackStarted(key)
  }

  res.writeHead(206,headers)

  // Stream directly from WebTorrent — fetches pieces on demand for any byte range
  const s=file.createReadStream({start,end})

  s.on("error",(e)=>{
    // Piece not downloaded yet — end response cleanly so Jellyfin retries
    console.log(`PIECE NOT READY at byte ${start} — Jellyfin will retry`)
    if(!res.writableEnded) res.end()
  })

  req.on("close",()=>{
    s.destroy()
    if(movieRegistry[key]) movieRegistry[key].lastAccess=Date.now()
    if(!isProbe&&streamActivity[key]){
      console.log(`PLAYBACK STOPPED → ${title}`)
      streamActivity[key]=false
    }
  })

  s.pipe(res)

})

server.listen(port,()=>{
  console.log(`STREAM SERVER LISTENING → port ${port} (${title})`)
})

movieRegistry[key].server=server

})

res.json({status:"added"})

})

/* =========================================
   IDLE STREAM CLEANER
========================================= */

setInterval(()=>{

for(const k in movieRegistry){

const stream = movieRegistry[k]

if(!stream.lastAccess) continue

if(Date.now() - stream.lastAccess > 10*60*1000){

console.log(`IDLE STREAM DESTROYED → ${k}`)

if(stream.bufferCheck){ clearInterval(stream.bufferCheck); stream.bufferCheck=null }

try{ stream.torrent.destroy({destroyStore:true}) }catch{}

try{ if(stream.server) stream.server.close() }catch{}

// Delete disk cache for this movie to free space
deleteDiskCache(stream.diskPath)

activePorts.delete(stream.port)

delete movieRegistry[k]
delete streamActivity[k]

saveState()

}

}

},60000)

/* =========================================
   PERIODIC CACHE CLEAN
========================================= */

setInterval(()=>{

if(Object.keys(movieRegistry).length===0){
 cleanCache()
}

},30*60*1000)

/* =========================================
   RESET SYSTEM
========================================= */

app.post("/nuke",(req,res)=>{

console.log("RESET SYSTEM TRIGGERED")

try{

for(const k in movieRegistry){

const s = movieRegistry[k]

if(s.bufferCheck){ clearInterval(s.bufferCheck); s.bufferCheck=null }

try{ s.torrent.destroy({destroyStore:true}) }catch{}

try{ if(s.server) s.server.close() }catch{}

activePorts.delete(s.port)

}

for(const k in movieRegistry){
delete movieRegistry[k]
}

for(const k in streamActivity){
delete streamActivity[k]
}

activePorts.clear()

cleanCache()
clearState()
console.log("STATE WIPED — no auto-recovery after manual nuke")

for(const folder of sessionFolders){

try{
fs.rmSync(folder,{
recursive:true,
force:true
})
}catch{}

}

sessionFolders.clear()

console.log("ALL STREAMS STOPPED")
console.log("CACHE CLEARED")

res.json({status:"reset"})

}catch(e){

console.log("RESET ERROR:",e.message)

res.status(500).json({error:"reset failed"})

}

})

/* =========================================
   SERVER START
========================================= */

async function startServer(){

console.log("Starting JellyStream server...")

mountDrive()

console.log("Waiting for rclone mount to stabilize...")

setTimeout(()=>{

console.log("Starting API server...")

app.listen(3000,"0.0.0.0",()=>{

console.log(`JellyStream running → http://${LOCAL_IP}:3000`)

})

},6000)

}

startServer()