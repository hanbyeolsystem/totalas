// ===========================================================
// totalas — Supabase 데이터 액세스 계층
// 모든 페이지의 데이터 CRUD 진입점.
// 기존 store.data 구조와 호환 (customers/printers/counters/contracts/meetings/prices/archive).
//
// 의존: auth.js (window.totalasAuth)
// 사용: await store.load() → 메모리 캐시 채움 → 페이지가 store.data 사용
//       변경 시: await store.upsertCustomer(c) 등 명시적 메서드
//       파일:  await store.uploadFile(path, blob) / downloadFile / deleteFile
// ===========================================================
(function(){
  const BUCKET = 'rental-files';

  const STORE = {
    data: {
      customers: {}, printers: {}, counters: {}, contracts: {},
      meetings: {}, archive: {}, prices: {}, billings: {}, meta: {},
    },
    _loaded: false,

    async load() {
      const supa = window.totalasAuth;
      if (!supa) throw new Error('인증 클라이언트가 준비되지 않았습니다');

      // 병렬 fetch (페이지네이션은 PostgREST 기본 1000 → range 활용)
      // applyFilter: 호출자가 WHERE 절을 추가할 수 있도록 query 빌더 변환 함수
      const fetchAll = async (table, applyFilter) => {
        const out = [];
        const page = 1000;
        let from = 0;
        while (true) {
          let q = supa.from(table).select('*').range(from, from + page - 1);
          if (applyFilter) q = applyFilter(q);
          const r = await q;
          if (r.error) throw r.error;
          out.push(...(r.data || []));
          if (!r.data || r.data.length < page) break;
          from += page;
        }
        return out;
      };

      const [custs, prints, counters, contracts, meetings, prices, archive, billings] = await Promise.all([
        fetchAll('rental_customers', q => q.is('archived_at', null)),
        fetchAll('rental_printers'),
        fetchAll('rental_counters'),
        fetchAll('rental_contracts'),
        fetchAll('rental_meetings'),
        fetchAll('rental_prices'),
        fetchAll('rental_archive'),
        fetchAll('rental_extra_billings').catch(() => []),  // 테이블 없으면 빈 배열
      ]);

      // customers: id 키
      this.data.customers = {};
      for (const c of custs) this.data.customers[c.id] = normalizeCustomer(c);

      // printers: serial 키, matched_customer_id 호환
      this.data.printers = {};
      for (const p of prints) {
        this.data.printers[p.serial] = {
          ...p,
          matched_customer_id: p.customer_id,
        };
      }

      // counters: period → serial → {bw,co,...}
      this.data.counters = {};
      for (const r of counters) {
        if (!this.data.counters[r.period]) this.data.counters[r.period] = {};
        this.data.counters[r.period][r.serial] = {
          bw: r.bw, co: r.co,
          last_update: r.last_update || '',
          source: r.source || '',
          source_file: r.source_file || '',
        };
      }

      // contracts: id 키
      this.data.contracts = {};
      for (const ct of contracts) this.data.contracts[ct.id] = ct;

      // meetings: id 키 — datetime은 meeting_date(timestamptz)로 매핑됨
      this.data.meetings = {};
      for (const m of meetings) {
        this.data.meetings[m.id] = {
          ...m,
          datetime: m.meeting_date || '',
        };
      }

      // prices: id 키
      this.data.prices = {};
      for (const p of prices) this.data.prices[p.id] = p;

      // archive: id 키 (cust 내부에서도 customer_id로 필터)
      this.data.archive = {};
      for (const a of archive) this.data.archive[a.id] = a;

      // billings: id 키
      this.data.billings = {};
      for (const b of (billings || [])) this.data.billings[b.id] = b;

      this._loaded = true;
      return this.data;
    },

    // localStorage 기반 save() 호환 — 사용 시 경고 + 무시
    save() {
      if (!STORE._warnedSave) {
        console.warn('[store] save() is deprecated. 명시적 upsert/delete 메서드를 사용하세요.');
        STORE._warnedSave = true;
      }
    },

    // ============================================================
    // 거래처
    // ============================================================
    async upsertCustomer(c) {
      const supa = window.totalasAuth;
      if (!c.id) c.id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const row = {
        id: c.id,
        company: c.company || '',
        ceo: c.ceo || '',
        biz_no: c.biz_no || '',
        corp_no: c.corp_no || '',
        biz_type: c.biz_type || '',
        biz_item: c.biz_item || '',
        address: c.address || '',
        phone: c.phone || '',
        fax: c.fax || '',
        email: c.email || '',
        kakao: c.kakao || '',
        memo: c.memo || '',
        serials: Array.isArray(c.serials) ? c.serials : [],
        base_fee: toInt(c.base_fee),
        bw_free: toInt(c.bw_free),
        bw_rate: toInt(c.bw_rate),
        co_free: toInt(c.co_free),
        co_rate: toInt(c.co_rate),
        source_sheet: c.source_sheet || '',
        asms_customer_id: c.asms_customer_id || null,
      };
      const { error } = await supa.from('rental_customers').upsert(row);
      if (error) throw error;
      this.data.customers[c.id] = { ...(this.data.customers[c.id] || {}), ...row };
      return this.data.customers[c.id];
    },

    async deleteCustomer(id) {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_customers').delete().eq('id', id);
      if (error) throw error;
      delete this.data.customers[id];
    },

    /** archive 된 거래처를 별도 load 해 this.data.customersArchived 에 채움. (최초 1회) */
    async loadArchivedCustomers() {
      if (this._archivedLoaded) return this.data.customersArchived || {};
      const supa = window.totalasAuth;
      const all = [];
      const page = 1000;
      let from = 0;
      while (true) {
        const r = await supa.from('rental_customers').select('*')
          .not('archived_at', 'is', null)
          .range(from, from + page - 1);
        if (r.error) throw r.error;
        all.push(...(r.data || []));
        if (!r.data || r.data.length < page) break;
        from += page;
      }
      this.data.customersArchived = {};
      for (const c of all) {
        this.data.customersArchived[c.id] = {
          ...c,
          serials: Array.isArray(c.serials) ? c.serials : [],
        };
      }
      this._archivedLoaded = true;
      return this.data.customersArchived;
    },

    /** archive 복구 — archived_at=null 로 다시 활성화. */
    async unarchiveCustomer(id) {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_customers')
        .update({ archived_at: null, archived_reason: null }).eq('id', id);
      if (error) throw error;
      const row = (this.data.customersArchived || {})[id];
      if (row) {
        row.archived_at = null;
        row.archived_reason = null;
        this.data.customers[id] = row;
        delete this.data.customersArchived[id];
      }
    },

    /** 거래처 archive (soft delete). */
    async archiveCustomer(id, reason) {
      const supa = window.totalasAuth;
      const at = new Date().toISOString();
      const { error } = await supa.from('rental_customers')
        .update({ archived_at: at, archived_reason: reason || '' }).eq('id', id);
      if (error) throw error;
      const row = this.data.customers[id];
      if (row) {
        row.archived_at = at;
        row.archived_reason = reason || '';
        if (!this.data.customersArchived) this.data.customersArchived = {};
        this.data.customersArchived[id] = row;
        delete this.data.customers[id];
      }
    },

    // ============================================================
    // 프린터 / 시리얼
    // ============================================================
    async upsertPrinter(p) {
      const supa = window.totalasAuth;
      const row = {
        serial: p.serial,
        model: p.model || '',
        group: p.group || '',
        asset_name: p.asset_name || '',
        customer_id: p.matched_customer_id || p.customer_id || null,
      };
      const { error } = await supa.from('rental_printers').upsert(row);
      if (error) throw error;
      this.data.printers[p.serial] = { ...row, matched_customer_id: row.customer_id };
      return this.data.printers[p.serial];
    },

    async deletePrinter(serial) {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_printers').delete().eq('serial', serial);
      if (error) throw error;
      delete this.data.printers[serial];
    },

    // ============================================================
    // 카운터 (월별 × 시리얼)
    // ============================================================
    async upsertCounter(period, serial, info) {
      const supa = window.totalasAuth;
      const row = {
        period, serial,
        bw: info.bw ?? null,
        co: info.co ?? null,
        last_update: info.last_update || '',
        source: info.source || '',
        source_file: info.source_file || '',
      };
      const { error } = await supa.from('rental_counters').upsert(row);
      if (error) throw error;
      if (!this.data.counters[period]) this.data.counters[period] = {};
      this.data.counters[period][serial] = info;
    },

    async upsertCounterBatch(period, rows) {
      // rows: { serial → { bw, co, ... } }
      const supa = window.totalasAuth;
      const list = Object.entries(rows).map(([serial, info]) => ({
        period, serial,
        bw: info.bw ?? null, co: info.co ?? null,
        last_update: info.last_update || '',
        source: info.source || '',
        source_file: info.source_file || '',
      }));
      // 200건씩 잘라서 업로드
      for (let i = 0; i < list.length; i += 200) {
        const batch = list.slice(i, i + 200);
        const { error } = await supa.from('rental_counters').upsert(batch);
        if (error) throw error;
      }
      if (!this.data.counters[period]) this.data.counters[period] = {};
      Object.assign(this.data.counters[period], rows);
    },

    async deleteCounter(period, serial) {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_counters').delete()
        .eq('period', period).eq('serial', serial);
      if (error) throw error;
      if (this.data.counters[period]) delete this.data.counters[period][serial];
    },

    async deleteCounterPeriod(period) {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_counters').delete().eq('period', period);
      if (error) throw error;
      delete this.data.counters[period];
    },

    async deleteCounterSerial(serial) {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_counters').delete().eq('serial', serial);
      if (error) throw error;
      for (const p of Object.keys(this.data.counters)) {
        delete this.data.counters[p][serial];
      }
    },

    // ============================================================
    // 계약서
    // ============================================================
    async upsertContract(c) {
      const supa = window.totalasAuth;
      if (!c.id) c.id = 'ct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const row = {
        id: c.id,
        customer_id: c.customer_id || null,
        company: c.company || '',
        company_top: c.company_top || '',
        requester: c.requester || '',
        address: c.address || '',
        invoice_kind: c.invoice_kind || '',
        biz_no: c.biz_no || '',
        mobile: c.mobile || '',
        tel_fax: c.tel_fax || '',
        email: c.email || '',
        items: c.items || [],
        deposit: toInt(c.deposit),
        total_fee: toInt(c.total_fee),
        contract_date: c.contract_date || '',
        contract_months: toInt(c.contract_months) || 36,
        pay_day: toInt(c.pay_day) || 25,
        terms_checked: c.terms_checked || [],
        extras_checked: c.extras_checked || [],
        special: c.special || [],
        bank: c.bank || {},
        source_file: c.source_file || '',
      };
      const { error } = await supa.from('rental_contracts').upsert(row);
      if (error) throw error;
      this.data.contracts[c.id] = { ...(this.data.contracts[c.id] || {}), ...row };
      return this.data.contracts[c.id];
    },

    async deleteContract(id) {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_contracts').delete().eq('id', id);
      if (error) throw error;
      delete this.data.contracts[id];
    },

    // ============================================================
    // Storage (rental-files 버킷)
    // path 예: 'meetings/<meeting_id>/<filename>', 'prices/<price_id>/...', 'archive/<customer_id>/<id>/<filename>'
    // ============================================================
    async uploadFile(path, blob, opts) {
      const supa = window.totalasAuth;
      const { error } = await supa.storage.from(BUCKET).upload(path, blob, {
        contentType: (opts && opts.contentType) || blob.type || 'application/octet-stream',
        upsert: true,
      });
      if (error) throw error;
      return path;
    },

    async downloadFile(path) {
      const supa = window.totalasAuth;
      const { data, error } = await supa.storage.from(BUCKET).download(path);
      if (error) throw error;
      return data; // Blob
    },

    async deleteFile(path) {
      if (!path) return;
      const supa = window.totalasAuth;
      const { error } = await supa.storage.from(BUCKET).remove([path]);
      if (error) throw error;
    },

    async getSignedUrl(path, expiresSec) {
      const supa = window.totalasAuth;
      const { data, error } = await supa.storage.from(BUCKET).createSignedUrl(path, expiresSec || 3600);
      if (error) throw error;
      return data.signedUrl;
    },

    // ============================================================
    // 음성미팅
    // ============================================================
    async upsertMeeting(m) {
      const supa = window.totalasAuth;
      if (!m.id) m.id = 'mt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const row = {
        id: m.id,
        customer_id: m.customer_id || null,
        title: m.title || '',
        memo: m.memo || '',
        attendees: m.attendees || '',
        audio_path: m.audio_path || '',
        duration_sec: toInt(m.duration_sec),
        meeting_date: m.datetime || m.meeting_date || null,
      };
      const { error } = await supa.from('rental_meetings').upsert(row);
      if (error) throw error;
      this.data.meetings[m.id] = { ...row, datetime: row.meeting_date || '' };
      return this.data.meetings[m.id];
    },

    async deleteMeeting(id) {
      const supa = window.totalasAuth;
      const m = this.data.meetings[id];
      if (m && m.audio_path) {
        try { await this.deleteFile(m.audio_path); } catch (e) { console.warn('audio delete:', e); }
      }
      const { error } = await supa.from('rental_meetings').delete().eq('id', id);
      if (error) throw error;
      delete this.data.meetings[id];
    },

    // ============================================================
    // 가격표 게시판
    // ============================================================
    async upsertPrice(p) {
      const supa = window.totalasAuth;
      if (!p.id) p.id = 'pr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const row = {
        id: p.id,
        category: p.category || 'product',
        title: p.title || '',
        author: p.author || '',
        description: p.description || p.memo || '',
        file_path: p.file_path || '',
        filename: p.filename || p.file_name || '',
        mime_type: p.mime_type || p.file_mime || '',
        file_size: toInt(p.file_size),
        pinned: !!p.pinned,
      };
      const { error } = await supa.from('rental_prices').upsert(row);
      if (error) throw error;
      this.data.prices[p.id] = { ...row };
      return this.data.prices[p.id];
    },

    async deletePrice(id) {
      const supa = window.totalasAuth;
      const p = this.data.prices[id];
      if (p && p.file_path) {
        try { await this.deleteFile(p.file_path); } catch (e) { console.warn('price file delete:', e); }
      }
      const { error } = await supa.from('rental_prices').delete().eq('id', id);
      if (error) throw error;
      delete this.data.prices[id];
    },

    // ============================================================
    // 추가요금 청구 (rental_extra_billings)
    //   · details: { serials:[{ serial, model, rows:[{period,bw,co}] }] }
    //   · 정책 snapshot (base_fee/bw_*/co_*) — 재계산해도 동일 결과
    // ============================================================
    async upsertBilling(b) {
      const supa = window.totalasAuth;
      if (!b.id) b.id = 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const row = {
        id: b.id,
        customer_id: b.customer_id || null,
        billing_no:  b.billing_no  || null,
        period_start: b.period_start,
        period_end:   b.period_end,
        issued_at: b.issued_at || new Date().toISOString(),
        base_fee: toInt(b.base_fee),
        bw_free:  toInt(b.bw_free),
        bw_rate:  toInt(b.bw_rate),
        co_free:  toInt(b.co_free),
        co_rate:  toInt(b.co_rate),
        details:  b.details || {},
        total_bw_fee: toInt(b.total_bw_fee),
        total_co_fee: toInt(b.total_co_fee),
        total_amount: toInt(b.total_amount),
        paid_at:  b.paid_at || null,
        memo:     b.memo || '',
      };
      const { error } = await supa.from('rental_extra_billings').upsert(row);
      if (error) throw error;
      this.data.billings[b.id] = { ...(this.data.billings[b.id] || {}), ...row };
      return this.data.billings[b.id];
    },

    async deleteBilling(id) {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_extra_billings').delete().eq('id', id);
      if (error) throw error;
      delete this.data.billings[id];
    },

    async markBillingPaid(id, paidAt) {
      const supa = window.totalasAuth;
      const iso = paidAt || new Date().toISOString();
      const { error } = await supa.from('rental_extra_billings')
        .update({ paid_at: iso }).eq('id', id);
      if (error) throw error;
      if (this.data.billings[id]) this.data.billings[id].paid_at = iso;
    },

    async markBillingUnpaid(id) {
      const supa = window.totalasAuth;
      const { error } = await supa.from('rental_extra_billings')
        .update({ paid_at: null }).eq('id', id);
      if (error) throw error;
      if (this.data.billings[id]) this.data.billings[id].paid_at = null;
    },

    /** 'BL-2026-NNNN' 다음 번호 생성. 같은 해 billing_no 의 최대 시퀀스 + 1. */
    nextBillingNo() {
      const yyyy = String(new Date().getFullYear());
      const prefix = `BL-${yyyy}-`;
      let max = 0;
      for (const b of Object.values(this.data.billings)) {
        const no = b.billing_no || '';
        if (no.startsWith(prefix)) {
          const n = parseInt(no.slice(prefix.length), 10);
          if (Number.isFinite(n) && n > max) max = n;
        }
      }
      return prefix + String(max + 1).padStart(4, '0');
    },

    // ============================================================
    // 고객자료실
    // ============================================================
    async upsertArchive(a) {
      const supa = window.totalasAuth;
      if (!a.id) a.id = 'ar_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const row = {
        id: a.id,
        customer_id: a.customer_id || null,
        category: a.category || 'etc',
        filename: a.filename || '',
        file_path: a.file_path || '',
        mime_type: a.mime_type || '',
        size_bytes: toInt(a.size_bytes),
        description: a.description || '',
      };
      const { error } = await supa.from('rental_archive').upsert(row);
      if (error) throw error;
      this.data.archive[a.id] = { ...row };
      return this.data.archive[a.id];
    },

    async deleteArchive(id) {
      const supa = window.totalasAuth;
      const a = this.data.archive[id];
      if (a && a.file_path) {
        try { await this.deleteFile(a.file_path); } catch (e) { console.warn('archive file delete:', e); }
      }
      const { error } = await supa.from('rental_archive').delete().eq('id', id);
      if (error) throw error;
      delete this.data.archive[id];
    },
  };

  function normalizeCustomer(c) {
    return {
      ...c,
      serials: Array.isArray(c.serials) ? c.serials : [],
    };
  }
  function toInt(v) {
    if (v == null || v === '') return 0;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? 0 : n;
  }

  window.store = STORE;
})();
