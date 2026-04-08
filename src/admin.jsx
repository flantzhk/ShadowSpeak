import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { fbDb } from './firebase.js';

const S = {
  page: { maxWidth:960, margin:"0 auto", padding:"24px 20px" },
  header: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 },
  title: { fontSize:24, fontWeight:900, color:"#1F3329" },
  card: { background:"#fff", borderRadius:14, padding:"20px 18px", border:"1px solid #EDE8E0", marginBottom:16 },
  label: { fontSize:13, fontWeight:800, color:"#5A554F", letterSpacing:1, textTransform:"uppercase", marginBottom:8 },
  stat: { fontSize:28, fontWeight:900, color:"#1F3329" },
  statSub: { fontSize:13, color:"#7A756E", marginTop:2 },
  table: { width:"100%", borderCollapse:"collapse", fontSize:13 },
  th: { textAlign:"left", padding:"10px 8px", borderBottom:"2px solid #EDE8E0", fontWeight:700, color:"#5A554F", fontSize:12 },
  td: { padding:"10px 8px", borderBottom:"1px solid #EDE8E0", fontSize:13 },
  input: { padding:"10px 14px", borderRadius:8, border:"1.5px solid #EDE8E0", fontSize:14, fontFamily:"inherit", outline:"none", width:"100%" },
  btn: { padding:"10px 18px", borderRadius:8, border:"none", background:"#1F3329", color:"#C4F000", fontSize:14, fontWeight:700, cursor:"pointer" },
  btnSm: { padding:"6px 12px", borderRadius:6, border:"none", fontSize:12, fontWeight:700, cursor:"pointer" },
  grid: { display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", gap:12, marginBottom:20 },
  search: { padding:"10px 14px", borderRadius:10, border:"1.5px solid #EDE8E0", fontSize:14, fontFamily:"inherit", outline:"none", width:"100%", marginBottom:16 },
};

function PasswordGate({ onAuth }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      const doc = await fbDb.collection("config").doc("admin").get();
      if (doc.exists && doc.data().password === pw) {
        sessionStorage.setItem("ss-admin-auth", "true");
        onAuth();
      } else {
        setError(true);
      }
    } catch (e) {
      console.warn("Admin auth check failed:", e);
      setError(true);
    }
    setChecking(false);
  };

  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{maxWidth:360,width:"100%",textAlign:"center"}}>
        <div style={{fontSize:40,marginBottom:12}}>🔧</div>
        <div style={{fontSize:22,fontWeight:900,color:"#1F3329",marginBottom:20}}>ShadowSpeak Admin</div>
        <input type="password" value={pw} onChange={e=>{setPw(e.target.value);setError(false);}}
          onKeyDown={e=>e.key==="Enter"&&check()}
          placeholder="Enter admin password"
          style={{...S.input,marginBottom:12,textAlign:"center"}} />
        <button onClick={check} disabled={checking} style={{...S.btn,width:"100%"}}>{checking?"Checking...":"Enter"}</button>
        {error&&<div style={{marginTop:10,fontSize:13,color:"#e74c3c",fontWeight:700}}>Incorrect password.</div>}
      </div>
    </div>
  );
}

function Dashboard() {
  const [users, setUsers] = useState([]);
  const [codes, setCodes] = useState([]);
  const [newCode, setNewCode] = useState("");
  const [newCodeDesc, setNewCodeDesc] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      // Load all users
      const snap = await fbDb.collection("users").get();
      const u = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setUsers(u);

      // Load promo codes
      const codeDoc = await fbDb.collection("config").doc("promoCodes").get();
      if (codeDoc.exists) setCodes(codeDoc.data().codes || []);

      setLoading(false);
    })();
  }, []);

  if (loading) return <div style={{textAlign:"center",padding:60,fontSize:16,fontWeight:700,color:"#7A756E"}}>Loading...</div>;

  const now = Date.now();
  const d7 = now - 7*24*60*60*1000;
  const d30 = now - 30*24*60*60*1000;
  const toTs = (d) => d?.toDate ? d.toDate().getTime() : d?.seconds ? d.seconds*1000 : new Date(d).getTime();

  const total = users.length;
  const new7 = users.filter(u => toTs(u.createdAt) > d7).length;
  const new30 = users.filter(u => toTs(u.createdAt) > d30).length;
  const premium = users.filter(u => u.isPremium).length;
  const free = total - premium;
  const canto = users.filter(u => u.selectedLanguage === "canto").length;
  const mandarin = users.filter(u => u.selectedLanguage === "mandarin").length;

  // Referral leaderboard
  const refCounts = {};
  users.forEach(u => {
    if (u.referredBy) {
      if (!refCounts[u.referredBy]) refCounts[u.referredBy] = { total:0, premium:0, free:0 };
      refCounts[u.referredBy].total++;
      if (u.isPremium) refCounts[u.referredBy].premium++;
      else refCounts[u.referredBy].free++;
    }
  });
  const refLeaderboard = Object.entries(refCounts).sort((a,b)=>b[1].total-a[1].total);

  // Filtered users
  const q = search.toLowerCase();
  const filtered = q ? users.filter(u =>
    (u.displayName||"").toLowerCase().includes(q) ||
    (u.email||"").toLowerCase().includes(q) ||
    (u.referredBy||"").toLowerCase().includes(q) ||
    (u.promoCodeUsed||"").toLowerCase().includes(q)
  ) : users;
  const sorted = filtered.sort((a,b) => toTs(b.createdAt) - toTs(a.createdAt));

  const toggleCode = async (idx) => {
    const updated = codes.map((c,i) => i===idx ? {...c, active:!c.active} : c);
    setCodes(updated);
    await fbDb.collection("config").doc("promoCodes").set({ codes: updated });
  };

  const addCode = async () => {
    if (!newCode.trim()) return;
    const updated = [...codes, { code: newCode.trim().toUpperCase(), active: true, description: newCodeDesc.trim() || "Manual" }];
    setCodes(updated);
    await fbDb.collection("config").doc("promoCodes").set({ codes: updated });
    setNewCode(""); setNewCodeDesc("");
  };

  const fmtDate = (d) => {
    if (!d) return "—";
    const dt = d?.toDate ? d.toDate() : new Date(d?.seconds ? d.seconds*1000 : d);
    return dt.toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" });
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div style={S.title}>ShadowSpeak Admin</div>
        <button onClick={()=>{sessionStorage.removeItem("ss-admin-auth");window.location.reload();}} style={{...S.btnSm,background:"#e74c3c",color:"#fff"}}>Sign out</button>
      </div>

      {/* Overview stats */}
      <div style={S.label}>Overview</div>
      <div style={S.grid}>
        <div style={S.card}><div style={S.stat}>{total}</div><div style={S.statSub}>Total users</div></div>
        <div style={S.card}><div style={S.stat}>{new7}</div><div style={S.statSub}>New (7 days)</div></div>
        <div style={S.card}><div style={S.stat}>{new30}</div><div style={S.statSub}>New (30 days)</div></div>
        <div style={S.card}><div style={S.stat}>{premium}</div><div style={S.statSub}>Premium ({total?Math.round(premium/total*100):0}%)</div></div>
        <div style={S.card}><div style={S.stat}>{free}</div><div style={S.statSub}>Free ({total?Math.round(free/total*100):0}%)</div></div>
        <div style={S.card}><div style={S.stat}>{canto}</div><div style={S.statSub}>Cantonese</div></div>
        <div style={S.card}><div style={S.stat}>{mandarin}</div><div style={S.statSub}>Mandarin</div></div>
      </div>

      {/* Referral leaderboard */}
      {refLeaderboard.length > 0 && <>
        <div style={S.label}>Referral Leaderboard</div>
        <div style={S.card}>
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>Code</th>
              <th style={S.th}>Signups</th>
              <th style={S.th}>Free</th>
              <th style={S.th}>Premium</th>
              <th style={S.th}>Est. Commission</th>
            </tr></thead>
            <tbody>
              {refLeaderboard.map(([code, data]) => (
                <tr key={code}>
                  <td style={{...S.td,fontWeight:700}}>{code}</td>
                  <td style={S.td}>{data.total}</td>
                  <td style={S.td}>{data.free}</td>
                  <td style={S.td}>{data.premium}</td>
                  <td style={S.td}>HKD {Math.round(data.premium * 598 * 0.2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>}

      {/* User table */}
      <div style={S.label}>Users ({filtered.length})</div>
      <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name, email, referral code..." style={S.search} />
      <div style={{...S.card,overflow:"auto"}}>
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>Name</th>
            <th style={S.th}>Email</th>
            <th style={S.th}>Signup</th>
            <th style={S.th}>Last Active</th>
            <th style={S.th}>Lang</th>
            <th style={S.th}>Status</th>
            <th style={S.th}>Tier</th>
            <th style={S.th}>Promo</th>
            <th style={S.th}>Ref</th>
          </tr></thead>
          <tbody>
            {sorted.slice(0, 200).map(u => (
              <tr key={u.id}>
                <td style={{...S.td,fontWeight:600,maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.displayName||"—"}</td>
                <td style={{...S.td,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.email||"—"}</td>
                <td style={S.td}>{fmtDate(u.createdAt)}</td>
                <td style={S.td}>{fmtDate(u.lastActiveAt)}</td>
                <td style={S.td}>{u.selectedLanguage||"—"}</td>
                <td style={{...S.td,fontWeight:700,color:u.isPremium?"#27ae60":"#7A756E"}}>{u.isPremium?"Premium":"Free"}</td>
                <td style={S.td}>{u.premiumTier||"—"}</td>
                <td style={S.td}>{u.promoCodeUsed||"—"}</td>
                <td style={S.td}>{u.referredBy||"—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length > 200 && <div style={{padding:10,textAlign:"center",fontSize:12,color:"#7A756E"}}>Showing first 200 of {sorted.length}</div>}
      </div>

      {/* Promo code manager */}
      <div style={S.label}>Promo Codes</div>
      <div style={S.card}>
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>Code</th>
            <th style={S.th}>Description</th>
            <th style={S.th}>Status</th>
            <th style={S.th}>Action</th>
          </tr></thead>
          <tbody>
            {codes.map((c, i) => (
              <tr key={i}>
                <td style={{...S.td,fontWeight:700,fontFamily:"monospace"}}>{c.code}</td>
                <td style={S.td}>{c.description}</td>
                <td style={{...S.td,fontWeight:700,color:c.active?"#27ae60":"#e74c3c"}}>{c.active?"Active":"Inactive"}</td>
                <td style={S.td}><button onClick={()=>toggleCode(i)} style={{...S.btnSm,background:c.active?"#e74c3c":"#27ae60",color:"#fff"}}>{c.active?"Deactivate":"Activate"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{display:"flex",gap:8,marginTop:14}}>
          <input value={newCode} onChange={e=>setNewCode(e.target.value)} placeholder="Code" style={{...S.input,flex:1}} />
          <input value={newCodeDesc} onChange={e=>setNewCodeDesc(e.target.value)} placeholder="Description" style={{...S.input,flex:1}} />
          <button onClick={addCode} style={S.btn}>Add</button>
        </div>
      </div>
    </div>
  );
}

function AdminApp() {
  const [authed, setAuthed] = useState(sessionStorage.getItem("ss-admin-auth") === "true");

  if (!authed) return <PasswordGate onAuth={() => setAuthed(true)} />;
  return <Dashboard />;
}

const root = createRoot(document.getElementById('root'));
root.render(React.createElement(AdminApp));
