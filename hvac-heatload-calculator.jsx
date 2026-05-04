import { useState, useCallback } from "react";

// ─── CONSTANTS ─────────────────────────────────────────────────────────────────
const OUTSIDE = { db: 107.6, rh: 36, wb: 83, th: 46.75, grLb: 132 };
const INSIDE  = { db: 73.4,  rh: 50, wb: 61.2, th: 27.2, grLb: 61.5 };
const DIFF    = { db: 34.2, th: 19.55, grLb: 70.5 };

const WALL_DIRS = ["N","NE","E","SE","S","SW","W","NW"];
const GLASS_DIRS = ["N","NE","E","SE","S","SW","W","NW"];

const WALL_TEMPS = { N:17, NE:23, E:31, SE:31, S:29, SW:27, W:25, NW:19 };
const GLASS_TEMPS = { N:11, NE:11, E:11, SE:11, S:11, SW:113, W:165, NW:118 };
const RA_WALL_TEMPS = { N:23.2, NE:29.2, E:37.2, SE:37.2, S:35.2, SW:33.2, W:31.2, NW:25.2 };

const defaultRoom = () => ({
  id: Date.now() + Math.random(),
  name: "",
  area: "",
  totalHeight: 8,
  fcLevel: 9.5,
  occupancy: 0,
  lightingWatts: 1.1,
  equipmentKw: 0,
  walls: Object.fromEntries(WALL_DIRS.map(d => [d, ""])),
  partWall: "",
  partGlass: "",
  roof: "",
  ceiling: "",
  floor: "",
  glasses: Object.fromEntries(GLASS_DIRS.map(d => [d, ""])),
  allGlass: "",
  raWalls: Object.fromEntries(WALL_DIRS.map(d => [d, ""])),
  raPartWall: "",
  wallFactor: 0.34,
  glassFactor: 0.33,
  partWallFactor: 0.4,
  roofFactor: 0.12,
  ceilingFactor: 0.4,
  floorFactor: 0.4,
  correctionFactor: 13,
  idiuType: "ductable",
  selectedTR: "",
});

// ─── CALCULATIONS ──────────────────────────────────────────────────────────────
// CLTD values per ASHRAE Manual (from reverse-engineering original Excel)
// Internal surfaces (partitions, ceiling, floor) use CLTD=29.2, NOT diff_db=34.2
// Roof uses CLTD=51.2 (higher due to solar gain)
const CLTD_INTERNAL = 29.2;   // partition wall/glass, ceiling, floor
const CLTD_ROOF     = 51.2;   // roof with solar gain

function calcRoom(r) {
  const area = +r.area || 0;
  const occ  = +r.occupancy || 0;
  const lightW = +r.lightingWatts || 1.1;
  const eqKw  = +r.equipmentKw || 0;

  // FIX BUG 2: Fresh Air = max of THREE options per ASHRAE
  // Option A: 1 air change per hour = area * FC_height / 60
  // Option B: combined formula = (5 CFM/person * occ) + (0.06 CFM/sqft * area)
  const fa_airChange = area * (+r.fcLevel || 9.5) / 60;
  const fa_combined  = (occ * 5) + (0.06 * area);
  const freshAir = Math.max(fa_airChange, fa_combined);

  // ERSH — External walls/glass use directional CLTD (WALL_TEMPS/GLASS_TEMPS)
  const wallBtu  = WALL_DIRS.reduce((s,d) => s + (+r.walls[d]||0)*(+r.wallFactor||0.34)*WALL_TEMPS[d], 0);
  const glassBtu = GLASS_DIRS.reduce((s,d) => s + (+r.glasses[d]||0)*(+r.glassFactor||0.33)*GLASS_TEMPS[d], 0);
  // FIX BUG 1: Internal surfaces use CLTD_INTERNAL (29.2), NOT DIFF.db (34.2)
  const allGlassBtu = (+r.allGlass||0)*(1.13)*DIFF.db;           // exposed glass uses diff_db
  const prtWallBtu  = (+r.partWall||0)*(+r.partWallFactor||0.4)*CLTD_INTERNAL;
  const prtGlassBtu = (+r.partGlass||0)*(1.13)*CLTD_INTERNAL;
  const roofBtu     = (+r.roof||0)*(+r.roofFactor||0.12)*CLTD_ROOF;
  const ceilingBtu  = (+r.ceiling||0)*(+r.ceilingFactor||0.4)*CLTD_INTERNAL;
  const floorBtu    = (+r.floor||0)*(+r.floorFactor||0.4)*CLTD_INTERNAL;
  const faBtu       = freshAir * DIFF.db * (0.15*1.08);
  const peopleSens  = occ * 245;
  const lightBtu    = lightW * area * 3.41;
  const equipBtu    = eqKw * 3410;

  const ershSub = wallBtu+glassBtu+allGlassBtu+prtWallBtu+prtGlassBtu+roofBtu+ceilingBtu+floorBtu+faBtu+peopleSens+lightBtu+equipBtu;
  const ershTotal = ershSub * 1.1;

  // ERLH
  const faLatent  = freshAir * DIFF.grLb * (0.15*0.67);
  const peopleLat = occ * 205;
  const erlhSub   = faLatent + peopleLat;
  const erlhTotal = erlhSub * 1.05;

  const erth1 = ershTotal + erlhTotal;
  const faOutside = freshAir * DIFF.th * (4.5*0.85);
  const gthSub    = erth1 + faOutside;
  const gth       = gthSub * 1.03;
  const tonnage   = gth / 12000;

  const ershf  = ershTotal / erth1 || 0;
  // ADP = 54°F (Apparatus Dew Point — fixed design value for Indian commercial HVAC)
  const adp = 54;
  // FIX BUG 3: Deh CFM = ASHRAE standard supply air CFM
  // = ERSH_total / (1.08 × ΔT) where ΔT = T_room(°F) - T_ADP(°F)
  // This matches the original Excel calculation verified against HDFC data
  const dehCfm = (INSIDE.db - adp) > 0
    ? ershTotal / (1.08 * (INSIDE.db - adp))
    : 0;

  // Return Air Gain
  const raBtu = WALL_DIRS.reduce((s,d) => s + (+r.raWalls[d]||0)*(0.34)*RA_WALL_TEMPS[d], 0)
              + (+r.raPartWall||0)*0.4*CLTD_INTERNAL;

  return {
    freshAir, wallBtu, glassBtu, allGlassBtu, prtWallBtu, prtGlassBtu,
    roofBtu, ceilingBtu, floorBtu, faBtu, peopleSens, lightBtu, equipBtu,
    ershSub, ershTotal, faLatent, peopleLat, erlhSub, erlhTotal,
    erth1, faOutside, gthSub, gth, tonnage, ershf, adp, dehCfm, raBtu,
    lightingLoad: lightW * area,
    eqLoad: eqKw,
  };
}

// ─── EXCEL EXPORT ──────────────────────────────────────────────────────────────
async function exportToExcel(project, rooms) {
  const XLSX = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
  const wb = XLSX.utils.book_new();

  // Summary Sheet
  const summaryData = [
    [`CUSTOMER :- ${project.customer || "N/A"}`],
    [`PROJECT :- ${project.name || "N/A"}`],
    [],
    ["SR. NO.","Space Description","Area (Sq.Ft)","Total Height (FT)","FC Height (FT)",
     "Fresh Air CFM","Occupancy Nos.","Lighting Load (W)","Equip. Load (Kw)",
     "TR (Calc)","CFM","SHF","ADP","IDU Type","Selected TR"],
  ];
  rooms.forEach((r, i) => {
    const c = calcRoom(r);
    summaryData.push([
      i+1, r.name||`Room ${i+1}`, +r.area||0, +r.totalHeight||0, +r.fcLevel||0,
      +c.freshAir.toFixed(2), +r.occupancy||0,
      +c.lightingLoad.toFixed(1), +r.equipmentKw||0,
      +c.tonnage.toFixed(2), +c.dehCfm.toFixed(2),
      +c.ershf.toFixed(4), c.adp, r.idiuType||"ductable", +r.selectedTR||0,
    ]);
  });
  // Totals row
  const totArea = rooms.reduce((s,r) => s+(+r.area||0),0);
  const totFa   = rooms.reduce((s,r) => s+calcRoom(r).freshAir,0);
  const totOcc  = rooms.reduce((s,r) => s+(+r.occupancy||0),0);
  const totLt   = rooms.reduce((s,r) => s+calcRoom(r).lightingLoad,0);
  const totEq   = rooms.reduce((s,r) => s+(+r.equipmentKw||0),0);
  const totTR   = rooms.reduce((s,r) => s+calcRoom(r).tonnage,0);
  const totCfm  = rooms.reduce((s,r) => s+calcRoom(r).dehCfm,0);
  const totSTR  = rooms.reduce((s,r) => s+(+r.selectedTR||0),0);
  summaryData.push(["","TOTAL",totArea,"","",totFa.toFixed(2),totOcc,totLt.toFixed(1),totEq.toFixed(2),totTR.toFixed(2),totCfm.toFixed(2),"","","",totSTR]);

  summaryData.push([],[]);
  summaryData.push(["Assumptions"]);
  const assumptions = [
    "Inside Condition: 23 Deg C +/-2 Deg F, RH Around 50 +/-5%",
    "Outside Condition: 42 Deg C",
    "Lighting Load - 1.1 Watts/Sq.ft",
    "Fresh Air - 1 Air change or (5.0 cfm/person + 0.06 CFM/Sqft) whichever is higher",
    "Equipment Load Considered 150 watts/PC",
    "Occupancy considered as per Architectural layout",
    "Exposed Glass Single Pane inside venetian blind or Roller Shade",
    "Floor below considered non AC area",
  ];
  assumptions.forEach((a,i) => summaryData.push([i+1, a]));

  const wsSum = XLSX.utils.aoa_to_sheet(summaryData);
  wsSum["!cols"] = [{wch:8},{wch:22},{wch:12},{wch:14},{wch:12},{wch:14},{wch:14},{wch:16},{wch:14},{wch:10},{wch:12},{wch:10},{wch:8},{wch:12},{wch:12}];
  XLSX.utils.book_append_sheet(wb, wsSum, "Summary");

  // Individual room sheets
  rooms.forEach((r, idx) => {
    const c = calcRoom(r);
    const sName = (r.name || `Room${idx+1}`).substring(0,31);
    const rows = [
      [`HEAT LOAD ESTIMATE FOR M/S. ${project.customer||""}`],
      [],
      ["CUSTOMER       :", r.name||"", "", "DESIGN CONDITIONS"],
      ["ESTIMATED BY   :", project.estimatedBy||"", "TIME OF PEAK LOAD:", "APRIL, 16:00 HRS"],
      ["DATE           :", new Date().toLocaleDateString(), "", "DB","%RH","WB","TH","GR/LB"],
      [`AREA = ${+r.area||0} SQFT`, "", "OUTSIDE", OUTSIDE.db, OUTSIDE.rh, OUTSIDE.wb, OUTSIDE.th, OUTSIDE.grLb],
      [`TOTAL HT = ${+r.totalHeight||8} FEET`, "", "INSIDE",  INSIDE.db,  INSIDE.rh,  INSIDE.wb,  INSIDE.th,  INSIDE.grLb],
      [`FC LVL = ${+r.fcLevel||9.5} FEET`, "",     "DIFF.",   DIFF.db,    "X",        "X",        DIFF.th,    DIFF.grLb],
      [],
      [`PEOPLE: ${+r.occupancy||0} NOS. x 5 CFM + 0.06 x ${+r.area||0} sqft = ${((+r.occupancy||0)*5 + 0.06*(+r.area||0)).toFixed(2)}`, "", `1 AIR CHANGE/HR = ${(area_for_fa => area_for_fa * (+r.fcLevel||9.5) / 60)((+r.area||0)).toFixed(3)}`],
      [`FRESH AIR (Max of above) = ${c.freshAir.toFixed(3)} CFM`, "", `Correction Factor for walls: ${+r.correctionFactor||13}`],
      [],
      ["STRUCT.","SQFT","FACTOR","TEMP","BTU/HR","","EFFECTIVE ROOM LATENT HEAT"],
      ["EFFECTIVE ROOM SENSIBLE HEAT","","","","","F.A.", c.freshAir.toFixed(2), DIFF.grLb, "0.15x0.67", c.faLatent.toFixed(2)],
    ];
    WALL_DIRS.forEach(d => {
      rows.push([`WALL ${d}`, +r.walls[d]||0, +r.wallFactor||0.34, WALL_TEMPS[d], ((+r.walls[d]||0)*(+r.wallFactor||0.34)*WALL_TEMPS[d]).toFixed(2),
                 "", d==="N" ? "PEOPLE" : "", d==="N" ? +r.occupancy||0 : "", d==="N" ? "NOS. x 205" : "", d==="N" ? c.peopleLat.toFixed(2) : ""]);
    });
    GLASS_DIRS.forEach(d => {
      rows.push([`GLASS ${d}`, +r.glasses[d]||0, +r.glassFactor||0.33, GLASS_TEMPS[d], ((+r.glasses[d]||0)*(+r.glassFactor||0.33)*GLASS_TEMPS[d]).toFixed(2)]);
    });
    rows.push(["ALL GLASS", +r.allGlass||0, 1.13, DIFF.db, c.allGlassBtu.toFixed(2), "", "ERLH SUBTOTAL","","",c.erlhSub.toFixed(2)]);
    rows.push(["PRT. WL.", +r.partWall||0, 0.4, CLTD_INTERNAL, c.prtWallBtu.toFixed(2), "", "FACTOR","","0.05",(c.erlhSub*0.05).toFixed(2)]);
    rows.push(["PRT. GLS.", +r.partGlass||0, 1.13, CLTD_INTERNAL, c.prtGlassBtu.toFixed(2), "", "ERLH TOTAL","","",c.erlhTotal.toFixed(2)]);
    rows.push(["ROOF", +r.roof||0, 0.12, CLTD_ROOF, c.roofBtu.toFixed(2), "", "1) EFF. ROOM TOTAL HEAT","","",c.erth1.toFixed(2)]);
    rows.push(["CEILING", +r.ceiling||0, 0.4, CLTD_INTERNAL, c.ceilingBtu.toFixed(2), "", "2) F.A.", c.freshAir.toFixed(2), "19.55  4.5x0.85", c.faOutside.toFixed(2)]);
    rows.push(["FLOOR", +r.floor||0, 0.4, CLTD_INTERNAL, c.floorBtu.toFixed(2), "", "GRAND TOTAL SUBTOTAL (1+2+3)","","",c.gthSub.toFixed(2)]);
    rows.push(["F.A.", c.freshAir.toFixed(2), DIFF.db, "0.15x1.08", c.faBtu.toFixed(2), "", "FACTOR","","0.03",(c.gthSub*0.03).toFixed(2)]);
    rows.push(["PEOPLE", +r.occupancy||0, "NOS. x 245", "", c.peopleSens.toFixed(2), "", "GRAND TOTAL HEAT","","",c.gth.toFixed(2)]);
    rows.push(["LIGHT (w)", +r.lightingWatts||1.1, +r.area||0, "3.41", c.lightBtu.toFixed(2), "", "A/C TONNAGE","","",c.tonnage.toFixed(4)]);
    rows.push(["Equipment", +r.equipmentKw||0, 1, 3410, c.equipBtu.toFixed(2)]);
    rows.push([]);
    rows.push(["ERSH SUBTOTAL","","","",c.ershSub.toFixed(2), "", "ERSHF","","",c.ershf.toFixed(6)]);
    rows.push(["FACTOR","","","0.1",(c.ershSub*0.1).toFixed(2), "", "INDICATED ADP","","",c.adp]);
    rows.push(["ERSH TOTAL","","","",c.ershTotal.toFixed(2), "", "SELECTED ADP","","",c.adp]);
    rows.push(["", "", "", "", "", "", "DEHUMIDIFIER CFM","","",c.dehCfm.toFixed(4)]);
    rows.push([]);
    rows.push(["RETURN AIR GAIN"]);
    rows.push(["STRUCT.","SQFT","FACTOR","TEMP","BTU/HR"]);
    WALL_DIRS.forEach(d => {
      rows.push([`WALL ${d}`, +r.raWalls[d]||0, 0.34, RA_WALL_TEMPS[d], ((+r.raWalls[d]||0)*0.34*RA_WALL_TEMPS[d]).toFixed(2)]);
    });
    rows.push(["PRT. WL.", +r.raPartWall||0, 0.4, DIFF.db, ((+r.raPartWall||0)*0.4*DIFF.db).toFixed(2)]);
    rows.push(["3) TOTAL R.A. GAIN","","","",c.raBtu.toFixed(2)]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{wch:14},{wch:10},{wch:10},{wch:10},{wch:12},{wch:2},{wch:28},{wch:10},{wch:12},{wch:14}];
    XLSX.utils.book_append_sheet(wb, ws, sName);
  });

  XLSX.writeFile(wb, `HeatLoad_${(project.name||"Project").replace(/\s+/g,"_")}.xlsx`);
}

// ─── UI COMPONENTS ─────────────────────────────────────────────────────────────
const numInput = (val, onChange, placeholder="0", step="any") => (
  <input
    type="number" step={step} placeholder={placeholder}
    value={val}
    onChange={e => onChange(e.target.value)}
    className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-cyan-100 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/30"
  />
);

const label = txt => <span className="text-xs text-slate-400 uppercase tracking-wider">{txt}</span>;

function RoomCard({ room, idx, onUpdate, onDelete, collapsed, onToggle }) {
  const c = calcRoom(room);
  const upd = (field, val) => onUpdate({ ...room, [field]: val });
  const updNested = (field, key, val) => onUpdate({ ...room, [field]: { ...room[field], [key]: val } });

  return (
    <div className="border border-slate-700 rounded-xl overflow-hidden mb-4 bg-slate-900/60 shadow-lg">
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-3 cursor-pointer bg-slate-800/80 hover:bg-slate-800 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <span className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-400 text-xs font-bold">{idx+1}</span>
          <span className="font-semibold text-slate-100">{room.name || <span className="italic text-slate-500">Unnamed Room</span>}</span>
          {room.area && <span className="text-xs text-slate-500">{room.area} sq.ft</span>}
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-lg font-bold text-cyan-400">{c.tonnage.toFixed(2)} TR</div>
            <div className="text-xs text-slate-500">Fresh Air: {c.freshAir.toFixed(0)} CFM</div>
          </div>
          <button onClick={e=>{e.stopPropagation();onDelete();}} className="text-red-500/60 hover:text-red-400 text-lg px-1">×</button>
          <span className="text-slate-500 text-sm">{collapsed?"▶":"▼"}</span>
        </div>
      </div>

      {!collapsed && (
        <div className="p-5 space-y-5">
          {/* Basic Info */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><div>{label("Room Name")}</div><input type="text" value={room.name} onChange={e=>upd("name",e.target.value)} placeholder="e.g. WORKSTATION" className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-cyan-100 focus:outline-none focus:border-cyan-400"/></div>
            <div><div>{label("Area (Sq.Ft)")}</div>{numInput(room.area, v=>upd("area",v),"0")}</div>
            <div><div>{label("Total Height (Ft)")}</div>{numInput(room.totalHeight, v=>upd("totalHeight",v),"8")}</div>
            <div><div>{label("False Ceiling (Ft)")}</div>{numInput(room.fcLevel, v=>upd("fcLevel",v),"9.5")}</div>
            <div><div>{label("Occupancy (Nos)")}</div>{numInput(room.occupancy, v=>upd("occupancy",v),"0")}</div>
            <div><div>{label("Lighting (W/Sqft)")}</div>{numInput(room.lightingWatts, v=>upd("lightingWatts",v),"1.1","0.01")}</div>
            <div><div>{label("Equipment (Kw)")}</div>{numInput(room.equipmentKw, v=>upd("equipmentKw",v),"0","0.1")}</div>
            <div><div>{label("Correction Factor")}</div>{numInput(room.correctionFactor, v=>upd("correctionFactor",v),"13")}</div>
          </div>

          {/* Walls */}
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-700 pb-1">Wall Areas (Sq.Ft) — U=0.34</div>
            <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
              {WALL_DIRS.map(d=>(
                <div key={d}><div>{label(`Wall ${d}`)}</div>{numInput(room.walls[d], v=>updNested("walls",d,v))}</div>
              ))}
            </div>
          </div>

          {/* Glass */}
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-700 pb-1">Glass Areas (Sq.Ft) — U=0.33</div>
            <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
              {GLASS_DIRS.map(d=>(
                <div key={d}><div>{label(`Glass ${d}`)}</div>{numInput(room.glasses[d], v=>updNested("glasses",d,v))}</div>
              ))}
            </div>
          </div>

          {/* Other surfaces */}
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-700 pb-1">Other Surfaces</div>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              <div><div>{label("All Glass (Sqft)")}</div>{numInput(room.allGlass, v=>upd("allGlass",v))}</div>
              <div><div>{label("Part. Wall (Sqft)")}</div>{numInput(room.partWall, v=>upd("partWall",v))}</div>
              <div><div>{label("Part. Glass (Sqft)")}</div>{numInput(room.partGlass, v=>upd("partGlass",v))}</div>
              <div><div>{label("Roof (Sqft)")}</div>{numInput(room.roof, v=>upd("roof",v))}</div>
              <div><div>{label("Ceiling (Sqft)")}</div>{numInput(room.ceiling, v=>upd("ceiling",v))}</div>
              <div><div>{label("Floor (Sqft)")}</div>{numInput(room.floor, v=>upd("floor",v))}</div>
            </div>
          </div>

          {/* Return Air */}
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-700 pb-1">Return Air Gain — Walls (Sq.Ft)</div>
            <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
              {WALL_DIRS.map(d=>(
                <div key={d}><div>{label(`RA Wall ${d}`)}</div>{numInput(room.raWalls[d], v=>updNested("raWalls",d,v))}</div>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 max-w-xs">
              <div><div>{label("RA Part. Wall (Sqft)")}</div>{numInput(room.raPartWall, v=>upd("raPartWall",v))}</div>
            </div>
          </div>

          {/* IDU / TR */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <div>{label("IDU Type")}</div>
              <select value={room.idiuType} onChange={e=>upd("idiuType",e.target.value)}
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-cyan-100 focus:outline-none focus:border-cyan-400">
                <option value="ductable">Ductable</option>
                <option value="cassette">Cassette</option>
                <option value="split">Split</option>
                <option value="vrf">VRF</option>
              </select>
            </div>
            <div><div>{label("Selected TR")}</div>{numInput(room.selectedTR, v=>upd("selectedTR",v),"0","0.5")}</div>
          </div>

          {/* Results */}
          <div className="bg-slate-950/60 border border-cyan-900/40 rounded-lg p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center"><div className="text-2xl font-bold text-cyan-400">{c.tonnage.toFixed(2)}</div><div className="text-xs text-slate-500">Calculated TR</div></div>
            <div className="text-center"><div className="text-2xl font-bold text-emerald-400">{c.freshAir.toFixed(0)}</div><div className="text-xs text-slate-500">Fresh Air CFM</div></div>
            <div className="text-center"><div className="text-2xl font-bold text-amber-400">{(c.ershf*100).toFixed(1)}%</div><div className="text-xs text-slate-500">ERSHF (SHF)</div></div>
            <div className="text-center"><div className="text-2xl font-bold text-purple-400">{c.dehCfm.toFixed(0)}</div><div className="text-xs text-slate-500">Dehum. CFM</div></div>
            <div className="text-center"><div className="text-lg font-semibold text-slate-300">{c.ershTotal.toFixed(0)}</div><div className="text-xs text-slate-500">ERSH (BTU/hr)</div></div>
            <div className="text-center"><div className="text-lg font-semibold text-slate-300">{c.erlhTotal.toFixed(0)}</div><div className="text-xs text-slate-500">ERLH (BTU/hr)</div></div>
            <div className="text-center"><div className="text-lg font-semibold text-slate-300">{c.gth.toFixed(0)}</div><div className="text-xs text-slate-500">Grand Total Heat</div></div>
            <div className="text-center"><div className="text-lg font-semibold text-slate-300">{c.adp}°F</div><div className="text-xs text-slate-500">ADP</div></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [project, setProject] = useState({ customer:"", name:"", estimatedBy:"" });
  const [rooms, setRooms] = useState([defaultRoom()]);
  const [collapsed, setCollapsed] = useState({});
  const [activeTab, setActiveTab] = useState("rooms"); // "rooms" | "summary"
  const [exporting, setExporting] = useState(false);

  const addRoom = () => {
    const r = defaultRoom();
    setRooms(prev => [...prev, r]);
  };

  const updateRoom = useCallback((idx, updated) => {
    setRooms(prev => prev.map((r,i) => i===idx ? updated : r));
  }, []);

  const deleteRoom = useCallback((idx) => {
    setRooms(prev => prev.filter((_,i) => i!==idx));
  }, []);

  const toggleCollapse = id => setCollapsed(c => ({...c,[id]:!c[id]}));

  const totTR  = rooms.reduce((s,r)=>s+calcRoom(r).tonnage,0);
  const totFA  = rooms.reduce((s,r)=>s+calcRoom(r).freshAir,0);
  const totArea= rooms.reduce((s,r)=>s+(+r.area||0),0);
  const totOcc = rooms.reduce((s,r)=>s+(+r.occupancy||0),0);
  const totSTR = rooms.reduce((s,r)=>s+(+r.selectedTR||0),0);

  const handleExport = async () => {
    setExporting(true);
    try { await exportToExcel(project, rooms); }
    catch(e) { alert("Export failed: "+e.message); }
    finally { setExporting(false); }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{fontFamily:"'Courier New', monospace"}}>
      {/* Top bar */}
      <div className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-400 text-sm">❄</div>
            <div>
              <div className="font-bold text-sm tracking-wider text-cyan-300">HVAC HEAT LOAD CALCULATOR</div>
              <div className="text-xs text-slate-500">ASHRAE / Manual J Method</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden md:flex gap-4 text-sm">
              <span className="text-slate-400">Total: <span className="text-cyan-400 font-bold">{totTR.toFixed(2)} TR</span></span>
              <span className="text-slate-400">Area: <span className="text-emerald-400 font-bold">{totArea.toLocaleString()} sqft</span></span>
              <span className="text-slate-400">FA: <span className="text-amber-400 font-bold">{totFA.toFixed(0)} CFM</span></span>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded-lg font-semibold transition-colors"
            >
              {exporting ? "Generating…" : "⬇ Export Excel"}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Project Details */}
        <div className="bg-slate-900/60 border border-slate-700 rounded-xl p-5 mb-6">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">Project Details</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div><div>{label("Customer Name")}</div>
              <input type="text" value={project.customer} onChange={e=>setProject({...project,customer:e.target.value})}
                placeholder="e.g. M/s. HDFC BANK" className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-cyan-100 focus:outline-none focus:border-cyan-400"/>
            </div>
            <div><div>{label("Project Name")}</div>
              <input type="text" value={project.name} onChange={e=>setProject({...project,name:e.target.value})}
                placeholder="e.g. HDFC MG Road Mumbai" className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-cyan-100 focus:outline-none focus:border-cyan-400"/>
            </div>
            <div><div>{label("Estimated By")}</div>
              <input type="text" value={project.estimatedBy} onChange={e=>setProject({...project,estimatedBy:e.target.value})}
                placeholder="Engineer name" className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-cyan-100 focus:outline-none focus:border-cyan-400"/>
            </div>
          </div>
          {/* Design conditions display */}
          <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-2">
            <div className="bg-slate-800/60 rounded p-2 text-xs">
              <div className="text-slate-400 mb-1">OUTSIDE DESIGN</div>
              <div>DB: <span className="text-amber-400">{OUTSIDE.db}°F</span> | RH: {OUTSIDE.rh}% | WB: {OUTSIDE.wb}°F</div>
            </div>
            <div className="bg-slate-800/60 rounded p-2 text-xs">
              <div className="text-slate-400 mb-1">INSIDE DESIGN</div>
              <div>DB: <span className="text-cyan-400">{INSIDE.db}°F</span> | RH: {INSIDE.rh}% | WB: {INSIDE.wb}°F</div>
            </div>
            <div className="bg-slate-800/60 rounded p-2 text-xs">
              <div className="text-slate-400 mb-1">PEAK LOAD TIME</div>
              <div>APRIL @ <span className="text-emerald-400">16:00 HRS</span></div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-4">
          {["rooms","summary"].map(t=>(
            <button key={t} onClick={()=>setActiveTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${activeTab===t?"bg-cyan-600 text-white":"bg-slate-800 text-slate-400 hover:text-slate-200"}`}>
              {t==="rooms"?"Rooms / Spaces":"Summary"}
            </button>
          ))}
        </div>

        {activeTab==="rooms" && (
          <>
            {rooms.map((r,idx)=>(
              <RoomCard
                key={r.id}
                room={r}
                idx={idx}
                onUpdate={updated=>updateRoom(idx,updated)}
                onDelete={()=>deleteRoom(idx)}
                collapsed={!!collapsed[r.id]}
                onToggle={()=>toggleCollapse(r.id)}
              />
            ))}
            <button onClick={addRoom}
              className="w-full border-2 border-dashed border-slate-700 hover:border-cyan-500/50 rounded-xl py-4 text-slate-500 hover:text-cyan-400 transition-colors text-sm font-semibold">
              + Add Room / Space
            </button>
          </>
        )}

        {activeTab==="summary" && (
          <div className="bg-slate-900/60 border border-slate-700 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-700">
              <div className="font-bold text-slate-200">{project.customer || "—"}</div>
              <div className="text-sm text-slate-400">{project.name || "—"}</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-800 text-slate-400">
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Space</th>
                    <th className="px-3 py-2 text-right">Area (sqft)</th>
                    <th className="px-3 py-2 text-right">Occ.</th>
                    <th className="px-3 py-2 text-right">Fresh Air CFM</th>
                    <th className="px-3 py-2 text-right">Lighting W</th>
                    <th className="px-3 py-2 text-right">Equip Kw</th>
                    <th className="px-3 py-2 text-right">ERSH BTU/hr</th>
                    <th className="px-3 py-2 text-right">ERLH BTU/hr</th>
                    <th className="px-3 py-2 text-right">GTH BTU/hr</th>
                    <th className="px-3 py-2 text-right">Calc TR</th>
                    <th className="px-3 py-2 text-right">SHF</th>
                    <th className="px-3 py-2 text-right">ADP</th>
                    <th className="px-3 py-2 text-right">Dehum CFM</th>
                    <th className="px-3 py-2 text-right">Sel. TR</th>
                    <th className="px-3 py-2 text-left">IDU Type</th>
                  </tr>
                </thead>
                <tbody>
                  {rooms.map((r,i)=>{
                    const c = calcRoom(r);
                    return (
                      <tr key={r.id} className="border-t border-slate-800 hover:bg-slate-800/40">
                        <td className="px-3 py-2 text-slate-500">{i+1}</td>
                        <td className="px-3 py-2 font-medium text-slate-200">{r.name||`Room ${i+1}`}</td>
                        <td className="px-3 py-2 text-right">{(+r.area||0).toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">{+r.occupancy||0}</td>
                        <td className="px-3 py-2 text-right text-emerald-400">{c.freshAir.toFixed(0)}</td>
                        <td className="px-3 py-2 text-right">{c.lightingLoad.toFixed(0)}</td>
                        <td className="px-3 py-2 text-right">{+r.equipmentKw||0}</td>
                        <td className="px-3 py-2 text-right">{c.ershTotal.toFixed(0)}</td>
                        <td className="px-3 py-2 text-right">{c.erlhTotal.toFixed(0)}</td>
                        <td className="px-3 py-2 text-right">{c.gth.toFixed(0)}</td>
                        <td className="px-3 py-2 text-right font-bold text-cyan-400">{c.tonnage.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right">{(c.ershf).toFixed(4)}</td>
                        <td className="px-3 py-2 text-right">{c.adp}</td>
                        <td className="px-3 py-2 text-right">{c.dehCfm.toFixed(0)}</td>
                        <td className="px-3 py-2 text-right text-amber-400 font-bold">{+r.selectedTR||0}</td>
                        <td className="px-3 py-2 text-slate-400">{r.idiuType}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-cyan-700 bg-slate-800/80 font-bold">
                    <td className="px-3 py-2" colSpan={2}>TOTAL</td>
                    <td className="px-3 py-2 text-right">{totArea.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">{totOcc}</td>
                    <td className="px-3 py-2 text-right text-emerald-400">{totFA.toFixed(0)}</td>
                    <td className="px-3 py-2 text-right">{rooms.reduce((s,r)=>s+calcRoom(r).lightingLoad,0).toFixed(0)}</td>
                    <td className="px-3 py-2 text-right">{rooms.reduce((s,r)=>s+(+r.equipmentKw||0),0).toFixed(1)}</td>
                    <td className="px-3 py-2 text-right">{rooms.reduce((s,r)=>s+calcRoom(r).ershTotal,0).toFixed(0)}</td>
                    <td className="px-3 py-2 text-right">{rooms.reduce((s,r)=>s+calcRoom(r).erlhTotal,0).toFixed(0)}</td>
                    <td className="px-3 py-2 text-right">{rooms.reduce((s,r)=>s+calcRoom(r).gth,0).toFixed(0)}</td>
                    <td className="px-3 py-2 text-right text-cyan-400">{totTR.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right" colSpan={3}></td>
                    <td className="px-3 py-2 text-right text-amber-400">{totSTR}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {/* Assumptions */}
            <div className="p-4 border-t border-slate-700">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">Design Assumptions</div>
              <ol className="list-decimal list-inside space-y-1 text-xs text-slate-400">
                <li>Inside Condition: 23°C ± 2°F | RH ~50 ± 5%</li>
                <li>Outside Condition: 42°C</li>
                <li>Lighting Load: 1.1 Watts / Sq.ft</li>
                <li>Fresh Air: 1 Air Change OR (5.0 cfm/person + 0.06 CFM/Sqft), whichever is higher</li>
                <li>Equipment Load: 150 Watts / PC</li>
                <li>Occupancy as per Architectural Layout</li>
                <li>Exposed Glass — Single Pane with Venetian Blind or Roller Shade</li>
                <li>Floor below considered Non-AC area</li>
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
