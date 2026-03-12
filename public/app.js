const API = "http://192.168.2.191:3000";

// Keep track of streams started in this session
let activeStreams = {};
let lastAddedMagnet = null;

let searching = false;

/* ===============================
   MOVIE SEARCH
================================ */

async function search(){

if(searching) return;
searching = true;

try{

const status=document.getElementById("status");
const q=document.getElementById("search").value;

if(!q){
searching=false;
return;
}

status.innerText="Searching TMDB...";

console.log("SEARCH:",q);

const r=await fetch(`${API}/movies?q=${encodeURIComponent(q)}`);
const movies=await r.json();

const div=document.getElementById("movies");
div.innerHTML="";

movies.forEach(m=>{

const poster=m.poster
?`https://image.tmdb.org/t/p/w300${m.poster}`
:"https://via.placeholder.com/200x300";

const el=document.createElement("div");

el.className="movie";

el.innerHTML=`
<img src="${poster}">
<h3>${m.title} (${m.year})</h3>
<button onclick="torrents('${m.id}','${m.title.replace(/'/g,"\\'")}','${m.year}')">
Find Streams
</button>
`;

div.appendChild(el);

});

status.innerText="Found movies.";

}
catch(err){

console.error(err);
document.getElementById("status").innerText="Search failed.";

}
finally{

searching=false;

}

}


/* ===============================
   TORRENT SEARCH
================================ */

async function torrents(id,title,year){

const status=document.getElementById("status");

status.innerText=`Fetching streams for ${title}...`;

console.log("FETCH TORRENTS:",id);

try{

const r=await fetch(`${API}/torrents?tmdb=${id}`);
const torrents=await r.json();

if(!r.ok){
throw new Error("Failed to fetch streams from Jackett.");
}

const div=document.getElementById("movies");
div.innerHTML="";

const heading=document.createElement("div");
heading.style.gridColumn="1 / -1";

heading.innerHTML=`
<h2>Streams for ${title} (${year})</h2>
<button onclick="location.reload()">Back to Search</button>
<hr>
`;

div.appendChild(heading);

if(torrents.length===0){

div.innerHTML+=`
<p style="grid-column:1/-1;">
No streams found with enough seeds.
</p>
`;

status.innerText="No results.";
return;

}

torrents.forEach(t=>{

const el=document.createElement("div");

el.className="torrent";
el.style.gridColumn="1 / -1";

el.innerHTML=`
<h4>${t.title}</h4>
<p>
Size: <b>${t.size||"Unknown"}</b> |
Seeds: <b>${t.seeds}</b> |
Peers: ${t.peers}
</p>

<button onclick="addStream('${t.magnet.replace(/'/g,"\\'")}','${title.replace(/'/g,"\\'")}','${year}')">
Add to Jellyfin
</button>
`;

div.appendChild(el);

});

status.innerText="Select a stream.";

}
catch(err){

console.error(err);

status.innerHTML=`<b style="color:#ff4444;">Error:</b> ${err.message}`;

document.getElementById("movies").innerHTML=`
<div style="grid-column:1/-1;margin-top:20px;">
<button onclick="location.reload()">Back to Search</button>
</div>
`;

}

}


/* ===============================
   ADD STREAM
================================ */

async function addStream(magnet,title,year){

const status=document.getElementById("status");

console.log("ADD STREAM:",title);

if(lastAddedMagnet===magnet){
if(!confirm("You already tried this link. Try again anyway?"))
return;
}

if(activeStreams[title]){
if(!confirm(`"${title}" already starting. Replace it?`))
return;
}

status.innerText=`Starting stream for ${title}... please wait (~15s)`;

try{

const r=await fetch(`${API}/add`,{

method:"POST",

headers:{
"Content-Type":"application/json"
},

body:JSON.stringify({
magnet,
title,
year
})

});

const res=await r.json();

console.log("SERVER RESPONSE:",res);

if(res.status==="added"){

activeStreams[title]=magnet;
lastAddedMagnet=magnet;

status.innerHTML=`
<b style="color:#00ff00;">Success!</b>
"${title}" added.
`;

alert(`"${title}" added! It will appear in Jellyfin soon.`);

}
else{

throw new Error(res.error);

}

}
catch(err){

console.error(err);

status.innerHTML=`
<b style="color:#ff4444;">Error:</b> ${err.message}
`;

alert("Failed to add: "+err.message);

}

}