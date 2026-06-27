(() => {
  'use strict';
  const BRIDGE_URL = 'http://127.0.0.1:17345';

  function el(id) { return document.getElementById(id); }
  function setText(id, text, cls = '') {
    const node = el(id);
    if (!node) return;
    node.textContent = text;
    if (cls) node.className = cls;
  }
  function ymdToday() {
    const d = new Date();
    const off = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - off).toISOString().slice(0,10);
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
  }
  function rowsToCsv(rows, columns) {
    const header = columns.map(c => csvEscape(c.label)).join(',');
    const body = rows.map(row => columns.map(c => csvEscape(typeof c.get === 'function' ? c.get(row) : row[c.key])).join(',')).join('\r\n');
    return '\uFEFF' + header + '\r\n' + body;
  }
  function normalizeThaiDate(value) {
    const s = String(value || '').trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[3]}-${m[2]}-${Number(m[1]) + 543}`;
    return s;
  }

  window.checkSmartCardBridge = async function(silent = false) {
    const status = el('bridge-status');
    if (status) status.textContent = 'กำลังตรวจสอบเครื่องอ่านบัตร...';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${BRIDGE_URL}/health`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const reader = (data.readers || [])[0] || 'ไม่พบชื่อ Reader';
      if (status) {
        status.textContent = `พร้อมใช้งาน: ${reader}`;
        status.className = 'small fw-bold text-success';
      }
      return true;
    } catch (err) {
      if (status) {
        status.textContent = 'ยังไม่พบ Smart Card Bridge — เปิดไฟล์ Start-Bridge.cmd ที่คอมพิวเตอร์ก่อน';
        status.className = 'small fw-bold text-danger';
      }
      if (!silent) alert('ยังเชื่อมต่อเครื่องอ่านบัตรไม่ได้\n\n1) เสียบ uTrust 2700R\n2) เปิดโฟลเดอร์ smartcard-bridge\n3) ดับเบิลคลิก Start-Bridge.cmd\n4) กลับมากดอ่านบัตรอีกครั้ง');
      return false;
    }
  };

  function splitThaiName(fullName) {
    const clean = String(fullName || '').replace(/\s+/g,' ').trim();
    const prefixes = ['นาย','นางสาว','น.ส.','นาง','เด็กชาย','ด.ช.','เด็กหญิง','ด.ญ.'];
    let prefix = '';
    let rest = clean;
    for (const p of prefixes) {
      if (clean.startsWith(p)) { prefix = p; rest = clean.slice(p.length).trim(); break; }
    }
    const parts = rest.split(' ').filter(Boolean);
    return { prefix, fname: parts.shift() || '', lname: parts.join(' ') };
  }

  function fillDonorForm(data) {
    const parsed = splitThaiName(data.thFullName || data.fullName || '');
    const values = {
      id_card: data.citizenId || data.idCard || '',
      prefix: data.prefix || parsed.prefix || '',
      fname: data.firstName || parsed.fname || '',
      lname: data.lastName || parsed.lname || '',
      birth_date: data.birthDate || data.birthday || '',
      gender: data.gender || '',
      address: data.address || ''
    };
    Object.entries(values).forEach(([id, value]) => { const node = el(id); if (node && value) node.value = value; });
    const cardStatus = el('card-read-status');
    if (cardStatus) {
      cardStatus.textContent = `อ่านบัตรสำเร็จ: ${values.prefix}${values.fname} ${values.lname}`;
      cardStatus.className = 'small fw-bold text-success mt-1';
    }
    el('phone')?.focus();
  }

  window.readThaiIdCard = async function() {
    const btn = el('smartcard-read-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'กำลังอ่านบัตร...'; }
    const status = el('card-read-status');
    if (status) { status.textContent = 'กรุณาเสียบบัตรประชาชนให้สุด แล้วรอสักครู่'; status.className = 'small fw-bold text-primary mt-1'; }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`${BRIDGE_URL}/read-card`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
      fillDonorForm(data.card || data);
    } catch (err) {
      if (status) { status.textContent = `อ่านบัตรไม่สำเร็จ: ${err.message || err}`; status.className = 'small fw-bold text-danger mt-1'; }
      await checkSmartCardBridge(true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '💳 อ่านบัตรประชาชน'; }
    }
  };

  window.fillDonorFromHistory = async function() {
    const id = String(el('id_card')?.value || '').replace(/\D/g,'');
    if (!/^\d{13}$/.test(id) || !window.cnmiOffline?.isUnlocked()) return;
    try {
      const donor = await window.cnmiOffline.findDonorByIdCard(id);
      if (!donor) return;
      const map = { prefix: donor.prefix, fname: donor.fname, lname: donor.lname, birth_date: donor.birth, gender: donor.gender, address: donor.address, phone: donor.phone };
      Object.entries(map).forEach(([k,v]) => { const n=el(k); if(n && !n.value) n.value=v || ''; });
      setText('card-read-status', 'พบประวัติผู้บริจาคในเครื่องและเติมข้อมูลให้แล้ว', 'small fw-bold text-success mt-1');
    } catch (_) {}
  };

  window.saveMissionSettings = async function() {
    if (!window.cnmiOffline?.isUnlocked()) return alert('กรุณาเข้าสู่ระบบก่อน');
    const missionName = String(el('mission-name')?.value || '').trim();
    const start = String(el('bag-start')?.value || '').replace(/\D/g,'');
    const end = String(el('bag-end')?.value || '').replace(/\D/g,'');
    if (!start || !end || Number(start) > Number(end)) return alert('กรุณาระบุช่วงเลขถุงเริ่มต้นและสิ้นสุดให้ถูกต้อง');
    await window.cnmiOffline.setMeta('mission', { name: missionName, date: ymdToday(), updatedAt: new Date().toISOString() });
    await window.cnmiOffline.setMeta('bagRange', { start: Number(start), end: Number(end), next: Number(start) });
    await refreshMissionInfo();
    alert('บันทึกงานออกหน่วยและช่วงเลขถุงแล้ว');
  };

  async function refreshMissionInfo() {
    if (!window.cnmiOffline?.isUnlocked()) return;
    const mission = await window.cnmiOffline.getMeta('mission', {});
    const bag = await window.cnmiOffline.getMeta('bagRange', null);
    if (el('mission-name') && mission?.name) el('mission-name').value = mission.name;
    if (bag) {
      if (el('bag-start')) el('bag-start').value = bag.start || '';
      if (el('bag-end')) el('bag-end').value = bag.end || '';
      setText('bag-range-status', `เลขถุงถัดไป ${bag.next || bag.start} · สิ้นสุด ${bag.end}`, 'small fw-bold text-primary');
    } else setText('bag-range-status', 'ยังไม่ได้ตั้งช่วงเลขถุง', 'small fw-bold text-danger');
  }
  window.refreshMissionInfo = refreshMissionInfo;

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quote = false;
    for (let i=0;i<text.length;i++) {
      const ch=text[i], next=text[i+1];
      if (ch==='"' && quote && next==='"') { cell+='"'; i++; }
      else if (ch==='"') quote=!quote;
      else if (ch===',' && !quote) { row.push(cell); cell=''; }
      else if ((ch==='\n' || ch==='\r') && !quote) {
        if (ch==='\r' && next==='\n') i++;
        row.push(cell); cell='';
        if (row.some(x=>String(x).trim()!=='')) rows.push(row);
        row=[];
      } else cell+=ch;
    }
    row.push(cell); if (row.some(x=>String(x).trim()!=='')) rows.push(row);
    if (!rows.length) return [];
    const headers=rows.shift().map(h=>String(h).replace(/^\uFEFF/,'').trim());
    return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])));
  }

  window.importDonorHistory = async function() {
    const input = el('donor-import-file');
    const file = input?.files?.[0];
    if (!file) return alert('กรุณาเลือกไฟล์ Excel หรือ CSV');
    try {
      let rows=[];
      if (/\.xlsx?$/i.test(file.name)) {
        if (!window.XLSX) throw new Error('ยังโหลดตัวอ่าน Excel ไม่สำเร็จ กรุณาเชื่อมอินเทอร์เน็ตครั้งแรก หรือบันทึกไฟล์เป็น CSV UTF-8');
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
        const sheetName = wb.SheetNames.find(n => /donor/i.test(n)) || wb.SheetNames[0];
        rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false });
      } else rows = parseCsv(await file.text());
      const result = await window.cnmiOffline.importDonorRows(rows);
      const seconds = Number(result.elapsedMs || 0) / 1000;
      setText('import-status', `นำเข้าสำเร็จ ${result.ok} รายการ · ข้าม ${result.skipped} รายการ · ${seconds.toFixed(1)} วินาที`, 'small fw-bold text-success');
      alert(`นำเข้าประวัติผู้บริจาคสำเร็จ ${result.ok} รายการ\nใช้เวลา ${seconds.toFixed(1)} วินาที`);
    } catch (err) {
      setText('import-status', `นำเข้าไม่สำเร็จ: ${err.message || err}`, 'small fw-bold text-danger');
    }
  };

  const lisColumns = [
    {label:'DN',key:'dn'}, {label:'ID_Card',key:'idCard'}, {label:'Prefix',key:'prefix'}, {label:'FirstName',key:'fname'},
    {label:'LastName',key:'lname'}, {label:'Birthdate',get:r=>normalizeThaiDate(r.birth)}, {label:'Gender',key:'gender'},
    {label:'Address',key:'address'}, {label:'Phone',key:'phone'}, {label:'Weight',key:'weight'}, {label:'BP',key:'bp'},
    {label:'Pulse',key:'pulse'}, {label:'Temperature',key:'temp'}, {label:'Hb',key:'hb'}, {label:'Blood_Group',key:'group'},
    {label:'Bag_Number',get:r=>r.bag==='-'?'':r.bag}, {label:'Donor_Type',key:'type'}, {label:'Screening_Status',key:'status'},
    {label:'Reason',key:'reason'}, {label:'Save_Time',key:'saveTime'}, {label:'C1',key:'c1'}, {label:'C2',key:'c2'}, {label:'E1',key:'e1'}, {label:'E2',key:'e2'}
  ];

  window.exportLisCsv = async function() {
    const date = el('table-date')?.value || ymdToday();
    const rows = await window.cnmiOffline.getVisits(date);
    if (!rows.length) return alert('ไม่มีข้อมูลของวันที่เลือก');
    saveBlob(new Blob([rowsToCsv(rows, lisColumns)], {type:'text/csv;charset=utf-8'}), `CNMI-LIS-${date}.csv`);
  };

  window.exportEncryptedBackup = async function() {
    const backup = await window.cnmiOffline.exportEncryptedBackup();
    saveBlob(new Blob([JSON.stringify(backup)], {type:'application/json'}), `CNMI-Encrypted-Backup-${ymdToday()}.cnmi.json`);
  };

  window.copyLisRow = async function() {
    const date = el('table-date')?.value || ymdToday();
    const rows = await window.cnmiOffline.getVisits(date);
    const done = rows.filter(r => r.status === 'ผ่าน' || r.status === 'ไม่ผ่าน');
    if (!done.length) return alert('ยังไม่มีรายการที่คัดกรองแล้ว');
    const dn = prompt(`ใส่ DN ที่ต้องการคัดลอก\nตัวอย่าง: ${done[0].dn}`, done[0].dn);
    const row = done.find(r => r.dn === String(dn || '').trim());
    if (!row) return alert('ไม่พบ DN');
    const text = lisColumns.map(c => typeof c.get==='function'?c.get(row):row[c.key]).join('\t');
    await navigator.clipboard.writeText(text);
    alert('คัดลอกข้อมูล 1 รายแล้ว\nเปิด LIS แล้ววางตามขั้นตอนของหน่วยงาน หรือใช้เครื่องมือ LIS Assistant ใน ZIP');
  };

  window.clearMissionData = async function() {
    const confirm1 = confirm('ต้องการล้างข้อมูลผู้บริจาคและงานออกหน่วยจากเครื่องนี้ใช่หรือไม่?\nกรุณาส่งออก Backup และ LIS CSV ก่อน');
    if (!confirm1) return;
    const text = prompt('พิมพ์คำว่า CLEAR เพื่อยืนยัน');
    if (text !== 'CLEAR') return alert('ยกเลิกการล้างข้อมูล');
    await window.cnmiOffline.clearMissionData();
    await refreshMissionInfo();
    if (typeof loadTable === 'function') loadTable();
    alert('ล้างข้อมูลภารกิจแล้ว');
  };

  function updateConnectivity() {
    const node = el('connection-status');
    if (!node) return;
    node.textContent = navigator.onLine ? 'ออนไลน์ · แอปยังบันทึกในเครื่อง' : 'ออฟไลน์ · พร้อมใช้งาน';
    node.className = navigator.onLine ? 'connection-pill online' : 'connection-pill offline';
  }

  document.addEventListener('DOMContentLoaded', () => {
    updateConnectivity();
    addEventListener('online', updateConnectivity);
    addEventListener('offline', updateConnectivity);
    el('id_card')?.addEventListener('blur', window.fillDonorFromHistory);
    el('id_card')?.addEventListener('keydown', e => { if (e.key === 'Enter') window.fillDonorFromHistory(); });
    setTimeout(() => { refreshMissionInfo().catch(()=>{}); checkSmartCardBridge(true); }, 1200);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(console.error);
  });
})();
