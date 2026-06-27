(() => {
  'use strict';

  const DB_NAME = 'cnmi_blood_mobile_secure_v1';
  const DB_VERSION = 1;
  const PBKDF2_ITERATIONS = 250000;
  const SESSION_KEY = 'cnmi_local_session_token';
  const USER_KEY = 'cnmi_local_session_user';
  let dbPromise = null;
  let vaultKey = null;
  let activeUser = null;
  let activeToken = '';

  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8');

  function nowIso() { return new Date().toISOString(); }
  function localYmd(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function localDateTime(date = new Date()) {
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const y = date.getFullYear() + 543;
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${d}/${m}/${y} ${hh}:${mm}:${ss}`;
  }
  function randomBytes(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return a;
  }
  function b64(bytes) {
    let s = '';
    bytes.forEach(b => { s += String.fromCharCode(b); });
    return btoa(s);
  }
  function fromB64(text) {
    const s = atob(text);
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(text || '')));
    return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  async function deriveKey(password, saltB64) {
    const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({
      name: 'PBKDF2',
      salt: fromB64(saltB64),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptObject(value, key = vaultKey) {
    if (!key) throw new Error('กรุณาเข้าสู่ระบบใหม่เพื่อเปิดคลังข้อมูล');
    const iv = randomBytes(12);
    const plain = enc.encode(JSON.stringify(value));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return { iv: b64(iv), cipher: b64(new Uint8Array(cipher)) };
  }
  async function decryptObject(record, key = vaultKey) {
    if (!record || !record.iv || !record.cipher) return null;
    if (!key) throw new Error('กรุณาเข้าสู่ระบบใหม่เพื่อเปิดคลังข้อมูล');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(record.iv) }, key, fromB64(record.cipher));
    return JSON.parse(dec.decode(plain));
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'username' });
        if (!db.objectStoreNames.contains('donors')) db.createObjectStore('donors', { keyPath: 'idHash' });
        if (!db.objectStoreNames.contains('visits')) {
          const s = db.createObjectStore('visits', { keyPath: 'dn' });
          s.createIndex('date', 'date', { unique: false });
          s.createIndex('date_id', ['date', 'idHash'], { unique: true });
        }
        if (!db.objectStoreNames.contains('audit')) {
          const s = db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
          s.createIndex('timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('certs')) db.createObjectStore('certs', { keyPath: 'dn' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('เปิดฐานข้อมูลในเครื่องไม่สำเร็จ'));
    });
    return dbPromise;
  }

  async function tx(storeNames, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      const stores = {};
      storeNames.forEach(n => { stores[n] = t.objectStore(n); });
      let result;
      try { result = fn(stores, t); } catch (e) { reject(e); return; }
      t.oncomplete = () => Promise.resolve(result).then(resolve, reject);
      t.onerror = () => reject(t.error || new Error('ฐานข้อมูลในเครื่องเกิดข้อผิดพลาด'));
      t.onabort = () => reject(t.error || new Error('รายการถูกยกเลิก'));
    });
  }
  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function getStoreValue(store, key) { return reqP(store.get(key)); }
  async function getAll(store) { return reqP(store.getAll()); }

  async function getMeta(key, fallback = null) {
    const db = await openDb();
    const t = db.transaction('meta', 'readonly');
    const row = await reqP(t.objectStore('meta').get(key));
    return row ? row.value : fallback;
  }
  async function setMeta(key, value) {
    return tx(['meta'], 'readwrite', ({ meta }) => meta.put({ key, value }));
  }

  function sanitizeUser(user) {
    return {
      username: user.username,
      fullName: user.fullName || user.username,
      role: user.role || 'admin',
      position: user.position || 'Mobile Unit',
      approvalLevel: user.approvalLevel || 'admin',
      mustChangePassword: false,
      active: user.active !== false,
      email: user.email || '',
      lastLogin: user.lastLogin || ''
    };
  }

  async function audit(action, targetType = '', targetId = '', detail = '') {
    const user = activeUser || { username: 'system', fullName: 'System', role: 'system' };
    const row = {
      timestamp: nowIso(),
      displayTime: localDateTime(),
      username: user.username || 'system',
      fullName: user.fullName || '',
      role: user.role || '',
      action,
      targetType,
      targetId,
      detail,
      userAgent: navigator.userAgent
    };
    await tx(['audit'], 'readwrite', ({ audit: s }) => s.add(row));
  }

  async function firstUserExists() {
    const db = await openDb();
    const t = db.transaction('users', 'readonly');
    return (await reqP(t.objectStore('users').count())) > 0;
  }

  async function createFirstUser(username, password) {
    if (!username) throw new Error('กรุณาระบุชื่อผู้ใช้');
    if (password.length < 8) throw new Error('ครั้งแรก กรุณาตั้งรหัสผ่านอย่างน้อย 8 ตัวอักษร');
    const salt = b64(randomBytes(16));
    const key = await deriveKey(password, salt);
    const verifier = await encryptObject({ marker: 'CNMI-BLOOD-MOBILE-VAULT-V1' }, key);
    const user = {
      username,
      fullName: username,
      role: 'admin',
      position: 'Mobile Unit',
      approvalLevel: 'admin',
      active: true,
      salt,
      verifier,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastLogin: localDateTime()
    };
    await tx(['users'], 'readwrite', ({ users }) => users.put(user));
    vaultKey = key;
    activeUser = sanitizeUser(user);
    await audit('FIRST_ADMIN_CREATED', 'USER', username, 'สร้างผู้ดูแลเครื่องสำหรับคลัง Offline');
    return user;
  }

  async function verifyLogin(username, password) {
    const db = await openDb();
    const t = db.transaction('users', 'readonly');
    const user = await reqP(t.objectStore('users').get(username));
    if (!user || user.active === false) throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    const key = await deriveKey(password, user.salt);
    try {
      const check = await decryptObject(user.verifier, key);
      if (!check || check.marker !== 'CNMI-BLOOD-MOBILE-VAULT-V1') throw new Error('bad');
    } catch (_) {
      throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    vaultKey = key;
    user.lastLogin = localDateTime();
    user.updatedAt = nowIso();
    await tx(['users'], 'readwrite', ({ users }) => users.put(user));
    activeUser = sanitizeUser(user);
    return user;
  }

  function requireSession() {
    if (!vaultKey || !activeUser || !activeToken) throw new Error('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }

  async function login(data) {
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    let user;
    if (!(await firstUserExists())) user = await createFirstUser(username, password);
    else user = await verifyLogin(username, password);
    activeToken = b64(randomBytes(24));
    sessionStorage.setItem(SESSION_KEY, activeToken);
    sessionStorage.setItem(USER_KEY, JSON.stringify(sanitizeUser(user)));
    await audit('LOGIN_SUCCESS', 'USER', username, 'เข้าสู่ระบบ Offline สำเร็จ');
    return { status: 'success', token: activeToken, mustChangePassword: false, user: sanitizeUser(user) };
  }

  async function saveDonorAndVisit(data) {
    requireSession();
    const idCard = String(data.idCard || '').trim();
    if (!/^\d{13}$/.test(idCard)) throw new Error('เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก');
    for (const [k, label] of [['prefix','คำนำหน้า'],['fname','ชื่อ'],['lname','นามสกุล'],['birthDate','วันเกิด'],['gender','เพศ']]) {
      if (!String(data[k] || '').trim()) throw new Error(`กรุณาระบุ${label}`);
    }
    const idHash = await sha256Hex(idCard);
    const donor = {
      idCard,
      prefix: String(data.prefix || '').trim(),
      fname: String(data.fname || '').trim(),
      lname: String(data.lname || '').trim(),
      birth: String(data.birthDate || '').trim(),
      gender: String(data.gender || '').trim(),
      address: String(data.address || '').trim(),
      phone: String(data.phone || '').trim(),
      updatedAt: nowIso()
    };
    const date = localYmd();
    const db = await openDb();
    const lookupTx = db.transaction('visits', 'readonly');
    const existing = await reqP(lookupTx.objectStore('visits').index('date_id').get([date, idHash]));
    let dn;
    let isNew = false;
    if (existing) {
      dn = existing.dn;
    } else {
      const rows = await new Promise((resolve, reject) => {
        const t = db.transaction('visits', 'readonly');
        const r = t.objectStore('visits').index('date').getAll(IDBKeyRange.only(date));
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
      const prefix = date.replaceAll('-', '');
      let max = 0;
      rows.forEach(r => {
        const n = parseInt(String(r.dn || '').slice(8), 10);
        if (Number.isFinite(n) && n > max) max = n;
      });
      dn = prefix + String(max + 1).padStart(4, '0');
      isNew = true;
    }
    const donorEncrypted = await encryptObject(donor);
    await tx(['donors'], 'readwrite', ({ donors }) => donors.put({ idHash, ...donorEncrypted, updatedAt: nowIso() }));
    if (isNew) {
      const visit = {
        dn, date, idHash, bag: '', type: '', weight: '', bp: '', pulse: '', temp: '', hb: '',
        group: '', status: 'รอคัดกรอง', reason: '', saveTime: '', c1: '', c2: '', e1: '', e2: ''
      };
      const encrypted = await encryptObject(visit);
      await tx(['visits'], 'readwrite', ({ visits }) => visits.put({ dn, date, idHash, ...encrypted, updatedAt: nowIso() }));
    }
    await audit(isNew ? 'DONOR_REGISTER_NEW_VISIT' : 'DONOR_REGISTER_UPDATE', 'DN', dn, `บันทึกผู้บริจาค ID=*********${idCard.slice(-4)}`);
    return {
      status: 'success', dn,
      name: `${donor.prefix}${donor.fname} ${donor.lname}`,
      idCard, birth: donor.birth, gender: donor.gender, address: donor.address, phone: donor.phone
    };
  }

  async function getDonorByHash(idHash) {
    const db = await openDb();
    const t = db.transaction('donors', 'readonly');
    const row = await reqP(t.objectStore('donors').get(idHash));
    return row ? decryptObject(row) : null;
  }

  async function getVisits(targetDate) {
    requireSession();
    const date = String(targetDate || localYmd());
    const db = await openDb();
    const rows = await new Promise((resolve, reject) => {
      const t = db.transaction('visits', 'readonly');
      const r = t.objectStore('visits').index('date').getAll(IDBKeyRange.only(date));
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
    rows.sort((a,b) => String(b.dn).localeCompare(String(a.dn)));
    if (!rows.length) return [];

    // อ่าน donor records ทั้งชุดใน IndexedDB transaction เดียว แล้วถอดรหัสแบบขนาน
    // เพื่อลดเวลารอเมื่อมีผู้บริจาคจำนวนมากในวันเดียว
    const uniqueHashes = [...new Set(rows.map(r => r.idHash).filter(Boolean))];
    const donorRecords = await new Promise((resolve, reject) => {
      const found = new Map();
      const t = db.transaction('donors', 'readonly');
      const store = t.objectStore('donors');
      uniqueHashes.forEach(idHash => {
        const request = store.get(idHash);
        request.onsuccess = () => { if (request.result) found.set(idHash, request.result); };
      });
      t.oncomplete = () => resolve(found);
      t.onerror = () => reject(t.error || new Error('อ่านข้อมูลผู้บริจาคไม่สำเร็จ'));
      t.onabort = () => reject(t.error || new Error('การอ่านข้อมูลผู้บริจาคถูกยกเลิก'));
    });

    const [visits, donorPairs] = await Promise.all([
      Promise.all(rows.map(row => decryptObject(row))),
      Promise.all(uniqueHashes.map(async idHash => {
        const encrypted = donorRecords.get(idHash);
        return [idHash, encrypted ? await decryptObject(encrypted) : null];
      }))
    ]);
    const donors = new Map(donorPairs);

    return visits.map((visit, index) => {
      const row = rows[index];
      const donor = donors.get(row.idHash) || {};
      return {
        dn: visit.dn,
        name: `${donor.prefix || ''}${donor.fname || ''} ${donor.lname || ''}`.trim() || 'ไม่พบชื่อ',
        idCard: donor.idCard || '', prefix: donor.prefix || '', fname: donor.fname || '', lname: donor.lname || '',
        birth: donor.birth || '-', gender: donor.gender || '-', address: donor.address || '-', phone: donor.phone || '-',
        bag: visit.bag || '-', status: visit.status || 'รอคัดกรอง', reason: visit.reason || '', type: visit.type || '',
        group: visit.group || '', weight: visit.weight || '', bp: visit.bp || '', pulse: visit.pulse || '',
        temp: visit.temp || '', hb: visit.hb || '', saveTime: visit.saveTime || '',
        c1: visit.c1 || '', c2: visit.c2 || '', e1: visit.e1 || '', e2: visit.e2 || ''
      };
    });
  }

  function normalizeBag(raw) {
    return String(raw || '').trim().toUpperCase().replace(/^CN/, '');
  }
  async function nextBag(dn) {
    const cfg = await getMeta('bagRange', null);
    if (!cfg || !cfg.start || !cfg.end) throw new Error('กรุณาตั้งช่วงเลขถุงในเมนู “เตรียมออกหน่วย” ก่อนลงผลผ่าน');
    let next = Number(cfg.next || cfg.start);
    const end = Number(cfg.end);
    if (!Number.isFinite(next) || !Number.isFinite(end) || next > end) throw new Error('เลขถุงหมดหรือช่วงเลขถุงไม่ถูกต้อง');
    const bag = String(next);
    cfg.next = next + 1;
    cfg.lastDn = dn;
    await setMeta('bagRange', cfg);
    return bag;
  }

  async function saveScreening(dn, sc) {
    requireSession();
    const db = await openDb();
    const t = db.transaction('visits', 'readonly');
    const row = await reqP(t.objectStore('visits').get(String(dn || '').trim()));
    if (!row) throw new Error('ไม่พบ DN');
    const visit = await decryptObject(row);
    const status = String(sc.status || '').trim();
    if (!status) throw new Error('กรุณาเลือกผลคัดกรอง');
    const isPass = status === 'ผ่าน' || status === 'Passed';
    if (isPass) {
      for (const [k, label] of [['type','ประเภทผู้บริจาค'],['group','หมู่เลือด'],['weight','น้ำหนัก'],['bp','ความดัน'],['pulse','ชีพจร'],['temp','อุณหภูมิ'],['hb','ความเข้มเลือด']]) {
        if (!String(sc[k] || '').trim() || (k === 'group' && sc[k] === '-')) throw new Error(`กรุณาระบุ${label}`);
      }
      if (visit.bag) throw new Error('DN นี้มีเลขถุงแล้ว ไม่สามารถจ่ายเลขถุงซ้ำได้');
    } else if (!String(sc.reason || '').trim()) {
      throw new Error('กรุณาระบุเหตุผลที่ไม่ผ่าน');
    }
    const bag = isPass ? await nextBag(dn) : '';
    Object.assign(visit, {
      bag,
      type: String(sc.type || '').trim(), weight: String(sc.weight || '').trim(), bp: String(sc.bp || '').trim(),
      pulse: String(sc.pulse || '').trim(), temp: String(sc.temp || '').trim(), hb: String(sc.hb || '').trim(),
      group: String(sc.group || '').trim(), status: isPass ? 'ผ่าน' : 'ไม่ผ่าน', reason: String(sc.reason || '').trim(),
      saveTime: localDateTime()
    });
    if (isPass) {
      visit.c1 = `${bag}C11`;
      visit.c2 = `${bag}C21`;
      visit.e1 = `${bag}E1`;
      visit.e2 = `${bag}E2`;
    } else {
      visit.c1 = visit.c2 = visit.e1 = visit.e2 = '';
    }
    const encrypted = await encryptObject(visit);
    await tx(['visits'], 'readwrite', ({ visits }) => visits.put({ dn: row.dn, date: row.date, idHash: row.idHash, ...encrypted, updatedAt: nowIso() }));
    await audit(isPass ? 'SCREENING_PASS' : 'SCREENING_FAIL', 'DN', dn, isPass ? `เลขถุง=${bag} / group=${visit.group}` : `reason=${visit.reason}`);
    return { status: 'success', bagNumber: bag, saveTime: visit.saveTime, c1: visit.c1, c2: visit.c2, e1: visit.e1, e2: visit.e2 };
  }

  async function listAudit(data) {
    requireSession();
    const db = await openDb();
    const t = db.transaction('audit', 'readonly');
    let rows = await reqP(t.objectStore('audit').getAll());
    rows.sort((a,b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    const date = String(data.date || '');
    const user = String(data.username || '').toLowerCase();
    const action = String(data.action || '').toLowerCase();
    const limit = Math.min(300, Math.max(1, Number(data.limit || 100)));
    rows = rows.filter(r => {
      if (date && String(r.timestamp).slice(0,10) !== date) return false;
      if (user && !String(r.username).toLowerCase().includes(user)) return false;
      if (action && !String(r.action).toLowerCase().includes(action)) return false;
      return true;
    }).slice(0, limit);
    return rows.map(r => ({
      timestamp: r.displayTime || r.timestamp,
      username: r.username, fullName: r.fullName, role: r.role, action: r.action,
      targetType: r.targetType, targetId: r.targetId, detail: r.detail, userAgent: r.userAgent
    }));
  }

  async function issueCertificate(data) {
    requireSession();
    const dn = String(data.dn || '').trim();
    if (!dn) throw new Error('ไม่มี DN');
    const db = await openDb();
    const t = db.transaction('certs', 'readonly');
    const existing = await reqP(t.objectStore('certs').get(dn));
    if (existing) {
      const cert = await decryptObject(existing);
      return { status: 'ok', certNo: cert.certNo, issueDate: cert.issueDate, isNew: false };
    }
    const ymd = String(data.visitDate || localYmd());
    const [y,m,d] = ymd.split('-');
    const prefix = `${d}${m}${String((Number(y)+543)%100).padStart(2,'0')}`;
    const all = await new Promise((resolve, reject) => {
      const tt = db.transaction('certs','readonly');
      const r = tt.objectStore('certs').getAll(); r.onsuccess=()=>resolve(r.result||[]); r.onerror=()=>reject(r.error);
    });
    let max = 0;
    for (const row of all) {
      const c = await decryptObject(row);
      if (String(c.certNo || '').startsWith(prefix + '/')) max = Math.max(max, Number(String(c.certNo).split('/')[1]) || 0);
    }
    const certNo = `${prefix}/${String(max + 1).padStart(3,'0')}`;
    const cert = { certNo, issueDate: localYmd(), dn, name: data.name || '', idCard: data.idCard || '', visitDate: ymd, remark: data.remark || '' };
    const encrypted = await encryptObject(cert);
    await tx(['certs'], 'readwrite', ({ certs }) => certs.put({ dn, ...encrypted }));
    await audit('CERTIFICATE_ISSUE', 'DN', dn, `เลขใบรับรอง=${certNo}`);
    return { status: 'ok', certNo, issueDate: cert.issueDate, isNew: true };
  }

  async function rekeyAll(oldKey, newKey) {
    const db = await openDb();
    for (const storeName of ['donors','visits','certs']) {
      const rows = await new Promise((resolve,reject)=>{ const t=db.transaction(storeName,'readonly'); const r=t.objectStore(storeName).getAll(); r.onsuccess=()=>resolve(r.result||[]); r.onerror=()=>reject(r.error); });
      for (const row of rows) {
        const plain = await decryptObject(row, oldKey);
        const encrypted = await encryptObject(plain, newKey);
        const out = { ...row, ...encrypted, updatedAt: nowIso() };
        await tx([storeName], 'readwrite', s => s[storeName].put(out));
      }
    }
  }

  async function changePassword(data) {
    requireSession();
    const currentPassword = String(data.currentPassword || '');
    const newPassword = String(data.newPassword || '');
    if (newPassword.length < 8) throw new Error('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
    const db = await openDb();
    const userRow = await new Promise((resolve,reject)=>{ const t=db.transaction('users','readonly'); const r=t.objectStore('users').get(activeUser.username); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
    const oldKey = await deriveKey(currentPassword, userRow.salt);
    try { await decryptObject(userRow.verifier, oldKey); } catch (_) { throw new Error('รหัสผ่านเดิมไม่ถูกต้อง'); }
    const salt = b64(randomBytes(16));
    const newKey = await deriveKey(newPassword, salt);
    await rekeyAll(oldKey, newKey);
    userRow.salt = salt;
    userRow.verifier = await encryptObject({ marker: 'CNMI-BLOOD-MOBILE-VAULT-V1' }, newKey);
    userRow.updatedAt = nowIso();
    await tx(['users'], 'readwrite', ({ users }) => users.put(userRow));
    vaultKey = newKey;
    await audit('CHANGE_PASSWORD_SUCCESS', 'USER', activeUser.username, 'เปลี่ยนรหัสผ่านและเข้ารหัสข้อมูลใหม่สำเร็จ');
    return { status: 'success', message: 'เปลี่ยนรหัสผ่านสำเร็จ', user: activeUser };
  }


  async function findDonorByIdCard(idCard) {
    requireSession();
    const raw = String(idCard || '').replace(/\D/g, '');
    if (!/^\d{13}$/.test(raw)) return null;
    return getDonorByHash(await sha256Hex(raw));
  }

  async function exportDecryptedData() {
    requireSession();
    const visits = await getVisits(localYmd());
    return visits;
  }

  async function exportEncryptedBackup() {
    requireSession();
    const db = await openDb();
    const result = { format: 'CNMI-BLOOD-MOBILE-BACKUP-V1', exportedAt: nowIso(), stores: {} };
    for (const storeName of ['users','donors','visits','audit','meta','certs']) {
      result.stores[storeName] = await new Promise((resolve,reject)=>{ const t=db.transaction(storeName,'readonly'); const r=t.objectStore(storeName).getAll(); r.onsuccess=()=>resolve(r.result||[]); r.onerror=()=>reject(r.error); });
    }
    return result;
  }

  async function importDonorRows(rows) {
    requireSession();
    const startedAt = performance.now();
    let ok = 0, skipped = 0;
    const valid = [];
    const pick = (raw, names) => {
      const normalized = {};
      Object.keys(raw || {}).forEach(k => { normalized[String(k).toLowerCase().replace(/[^a-z0-9ก-๙]/g, '')] = raw[k]; });
      for (const name of names) {
        if (raw && raw[name] !== undefined && raw[name] !== null && String(raw[name]).trim() !== '') return raw[name];
        const key = String(name).toLowerCase().replace(/[^a-z0-9ก-๙]/g, '');
        if (normalized[key] !== undefined && normalized[key] !== null && String(normalized[key]).trim() !== '') return normalized[key];
      }
      return '';
    };

    for (const raw of rows || []) {
      const idCard = String(pick(raw, ['idCard','ID_Card','IDCard','เลขบัตรประชาชน'])).replace(/\D/g,'');
      if (!/^\d{13}$/.test(idCard)) { skipped++; continue; }
      valid.push({
        idCard,
        donor: {
          idCard,
          prefix: String(pick(raw, ['prefix','Prefix','คำนำหน้า'])).trim(),
          fname: String(pick(raw, ['fname','FirstName','First Name','ชื่อ'])).trim(),
          lname: String(pick(raw, ['lname','LastName','Last Name','นามสกุล'])).trim(),
          birth: String(pick(raw, ['birth','Birthdate','BirthDate','วันเกิด'])).trim(),
          gender: String(pick(raw, ['gender','Gender','Sex','เพศ'])).trim(),
          address: String(pick(raw, ['address','Address','ที่อยู่'])).trim(),
          phone: String(pick(raw, ['phone','Phone','Telephone','โทรศัพท์'])).trim(),
          updatedAt: nowIso()
        }
      });
    }

    // ทำ Crypto พร้อมกันเป็นชุด และเขียน IndexedDB ครั้งละหลายรายการ
    // เร็วกว่าการเปิด transaction ใหม่ทีละคนอย่างชัดเจน
    const BATCH_SIZE = 250;
    for (let offset = 0; offset < valid.length; offset += BATCH_SIZE) {
      const batch = valid.slice(offset, offset + BATCH_SIZE);
      const encryptedRows = await Promise.all(batch.map(async item => {
        const [idHash, encrypted] = await Promise.all([
          sha256Hex(item.idCard),
          encryptObject(item.donor)
        ]);
        return { idHash, ...encrypted, updatedAt: nowIso() };
      }));
      await tx(['donors'], 'readwrite', ({ donors }) => {
        encryptedRows.forEach(row => donors.put(row));
      });
      ok += encryptedRows.length;
    }

    const elapsedMs = Math.round(performance.now() - startedAt);
    await audit('DONOR_HISTORY_IMPORT', 'FILE', '', `นำเข้า ${ok} รายการ ข้าม ${skipped} รายการ ใช้เวลา ${elapsedMs} ms`);
    return { ok, skipped, elapsedMs };
  }

  async function clearMissionData() {
    requireSession();
    await tx(['donors','visits','certs','audit','meta'], 'readwrite', (s) => {
      s.donors.clear(); s.visits.clear(); s.certs.clear(); s.audit.clear(); s.meta.clear();
    });
    await audit('MISSION_DATA_CLEARED', 'DEVICE', '', 'ล้างข้อมูลภารกิจออกจากอุปกรณ์แล้ว');
  }

  window.cnmiOffline = {
    getMeta, setMeta, getVisits, findDonorByIdCard, exportDecryptedData, exportEncryptedBackup, importDonorRows, clearMissionData,
    isUnlocked: () => !!vaultKey,
    currentUser: () => activeUser
  };

  window.cnmiOfflineApiCall = async function(action, params = {}) {
    try {
      const data = typeof params.data === 'string' ? JSON.parse(params.data || '{}') : (params.data || {});
      switch (action) {
        case 'ping': return { status: 'ok', message: 'Offline backend พร้อมใช้งาน', time: localDateTime() };
        case 'login': return await login(data);
        case 'logout':
          if (activeUser) await audit('LOGOUT', 'USER', activeUser.username, 'ออกจากระบบ');
          vaultKey = null; activeUser = null; activeToken = '';
          sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(USER_KEY);
          return { status: 'success', message: 'ออกจากระบบแล้ว' };
        case 'getSessionUser':
          if (!vaultKey || !activeUser) return { status: 'error', message: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่' };
          return { status: 'success', user: activeUser };
        case 'changePassword': return await changePassword(data);
        case 'forgotPassword': return { status: 'error', message: 'คลัง Offline ไม่มีการส่ง OTP เพื่อความปลอดภัย หากลืมรหัสผ่านต้องใช้ Backup หรือเริ่มคลังใหม่' };
        case 'resetPasswordWithOtp': return { status: 'error', message: 'ไม่รองรับการรีเซตรหัสผ่านแบบ OTP ในโหมด Offline' };
        case 'saveDataToSheet': return await saveDonorAndVisit(data);
        case 'getRecentVisits': return await getVisits(params.date || params.targetDate || data.date || localYmd());
        case 'saveScreeningResult': return await saveScreening(params.dn, data);
        case 'logPrintAction':
          requireSession(); await audit(data.printType || 'PRINT', 'DN', data.dn || '', `เลขถุง=${data.bag || ''} ${data.certNo ? '/ ใบรับรอง=' + data.certNo : ''}`);
          return { status: 'success', message: 'บันทึกประวัติการพิมพ์แล้ว' };
        case 'issueCertificateNumber': return await issueCertificate(data);
        case 'listUsers': {
          requireSession();
          const db = await openDb(); const t = db.transaction('users','readonly'); const rows = await reqP(t.objectStore('users').getAll());
          return { status: 'success', users: rows.map(sanitizeUser) };
        }
        case 'listAuditLogs': return { status: 'success', logs: await listAudit(data) };
        case 'adminResetUserPassword': return { status: 'error', message: 'โหมด Offline ไม่อนุญาตให้ Admin รีเซตรหัสผ่านผู้อื่น' };
        case 'adminSetUserActive': return { status: 'error', message: 'โหมด Offline ใช้บัญชีผู้ดูแลเครื่องเพียงบัญชีเดียว' };
        default: return { status: 'error', message: `ยังไม่รองรับคำสั่ง ${action} ในโหมด Offline` };
      }
    } catch (err) {
      console.error('Offline API error', action, err);
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  };
})();
