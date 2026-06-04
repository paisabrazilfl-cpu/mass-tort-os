import { useEffect, useState, type ChangeEvent } from 'react';
import { Link } from 'wouter';
import { useToast } from '@/hooks/use-toast';
import { apiFetchRaw } from '@/lib/api-fetch';

interface OutreachBatch {
  id: number;
  filename: string;
  status: string;
  total_rows: number;
  processed_rows: number;
  success_count: number;
  duplicate_count: number;
  error_count: number;
  created_at: string;
}

interface PreviewResult {
  total_rows: number;
  headers: string[];
  column_mapping: Record<string, string>;
  available_fields: string[];
  sample_leads: Record<string, unknown>[];
}

type Step = 1 | 2 | 3 | 4;

// Calming sage + soft blue palette
const C = {
  bg: '#F7F9F6',
  card: '#FFFFFF',
  border: '#D4E4D4',
  borderDash: '#C8D8C8',
  sage: '#A8C5B5',
  sageDark: '#8FB5A0',
  sageLight: '#F0F6F1',
  blue: '#8AAFC4',
  blueLight: '#F0F4F8',
  warm: '#C4A48A',
  warmLight: '#F8F4F0',
  textDark: '#2D3E30',
  textMid: '#3A4E3C',
  textMuted: '#6B7B6C',
  textLight: '#8A9B8A',
  success: '#7BA899',
  warning: '#C4A48A',
  danger: '#C48A8A',
};

export default function OutreachPage() {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>(1);
  const [csvData, setCsvData] = useState('');
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [tortPageUrl, setTortPageUrl] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [batches, setBatches] = useState<OutreachBatch[]>([]);
  const [activeBatch, setActiveBatch] = useState<OutreachBatch | null>(null);

  useEffect(() => {
    apiFetchRaw('/api/outreach/batches')
      .then(r => r.ok ? r.json() : null)
      .then(data => data && setBatches(data.slice(0, 5)))
      .catch(() => {});
  }, []);

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    if (!['csv', 'vsc', 'txt'].includes(ext)) {
      toast({ title: 'Invalid file', description: 'Upload a CSV or VSC file.', variant: 'destructive' });
      return;
    }
    const text = await file.text();
    setCsvData(text);
    setFilename(file.name);
    setLoading(true);
    try {
      const res = await apiFetchRaw('/api/outreach/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv_data: text }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Preview failed');
      setPreview(await res.json() as PreviewResult);
      setStep(2);
    } catch (err: unknown) {
      toast({ title: 'Preview failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleStartOutreach = async () => {
    if (!tortPageUrl.trim()) {
      toast({ title: 'Case page URL required', description: 'Add the tort-specific page URL.', variant: 'destructive' });
      return;
    }
    if (!emailEnabled && !smsEnabled && !voiceEnabled) {
      toast({ title: 'Select at least one channel', description: 'Choose email, SMS, or voice.', variant: 'destructive' });
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetchRaw('/api/outreach/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csv_data: csvData,
          column_mapping: preview?.column_mapping ?? {},
          filename,
          tort_page_url: tortPageUrl,
          email_enabled: emailEnabled,
          sms_enabled: smsEnabled,
          voice_enabled: voiceEnabled,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Outreach failed');
      const data = (await res.json()) as { batch_id: number; total_rows: number };
      setActiveBatch({
        id: data.batch_id,
        filename,
        status: 'processing',
        total_rows: data.total_rows,
        processed_rows: 0,
        success_count: 0,
        duplicate_count: 0,
        error_count: 0,
        created_at: new Date().toISOString(),
      });
      setStep(3);
      pollBatch(data.batch_id);
    } catch (err: unknown) {
      toast({ title: 'Outreach failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const pollBatch = async (id: number) => {
    const poll = async () => {
      try {
        const res = await apiFetchRaw(`/api/outreach/batches/${id}`);
        if (!res.ok) return;
        const data = (await res.json()) as OutreachBatch;
        setActiveBatch(data);
        if (data.status === 'completed') {
          setStep(4);
          apiFetchRaw('/api/outreach/batches')
            .then(r => r.ok ? r.json() : null)
            .then(b => b && setBatches(b.slice(0, 5)))
            .catch(() => {});
          return;
        }
      } catch {}
      setTimeout(poll, 2500);
    };
    poll();
  };

  const reset = () => {
    setStep(1);
    setCsvData('');
    setFilename('');
    setPreview(null);
    setTortPageUrl('');
    setEmailEnabled(true);
    setSmsEnabled(true);
    setVoiceEnabled(false);
    setActiveBatch(null);
  };

  const channels = [
    { key: 'email', label: 'Email', desc: 'Tort page link + re-intake prompt', color: C.success },
    { key: 'sms',   label: 'SMS',   desc: 'Text re-intake link to eligible claimants', color: C.blue },
    { key: 'voice', label: 'Voice', desc: 'Launch Vapi dialer campaigns by tort', color: C.warm },
  ];

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', padding: '40px 24px' }}>

      {/* Header */}
      <div style={{ maxWidth: 680, margin: '0 auto 36px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: C.sage }} />
          <span style={{ fontSize: 11, color: C.textLight, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: 500 }}>Leads · Automations</span>
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: C.textDark, margin: '0 0 8px', letterSpacing: -0.3 }}>
          Outreach
        </h1>
        <p style={{ fontSize: 14, color: C.textMuted, margin: 0, lineHeight: 1.6, maxWidth: 520 }}>
          Upload claimants — existing leads are updated, not duplicated. Then dispatch email, SMS, or voice re-intake.
        </p>
      </div>

      {/* Step progress bar */}
      {step > 1 && (
        <div style={{ maxWidth: 680, margin: '0 auto 28px', background: C.card, borderRadius: 14, padding: '16px 24px' }}>
          <div style={{ display: 'flex', gap: 0, alignItems: 'center' }}>
            {(['Upload', 'Settings', 'Running', 'Done'] as const).map((label, i) => {
              const num = i + 1;
              const done = step > num;
              const active = step === num;
              return (
                <div key={label} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <div style={{
                      width: 26, height: 26, borderRadius: '50%',
                      background: done ? C.sage : active ? C.sage : C.card,
                      border: done || active ? 'none' : `1.5px solid ${C.border}`,
                      color: done ? '#fff' : active ? '#fff' : C.textLight,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 600, transition: 'all 0.3s',
                    }}>
                      {done ? '✓' : num}
                    </div>
                    <span style={{ fontSize: 10, color: done || active ? C.textMid : C.textLight, fontWeight: done || active ? 600 : 400, letterSpacing: 0.3 }}>
                      {label}
                    </span>
                  </div>
                  {i < 3 && (
                    <div style={{ flex: 1, height: 1.5, background: done ? C.sage : C.border, margin: '0 8px', marginBottom: 20, transition: 'background 0.3s' }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ maxWidth: 680, margin: '0 auto' }}>

        {/* STEP 1 — Upload */}
        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* Drop zone */}
            <div style={{
              background: C.card, borderRadius: 18, padding: '40px 32px', textAlign: 'center',
              border: `1.5px dashed ${C.borderDash}`,
            }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: C.sageLight, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <svg width={22} height={22} viewBox='0 0 24 24' fill='none' stroke={C.sage} strokeWidth={2} strokeLinecap='round' strokeLinejoin='round'>
                  <path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/>
                  <polyline points='17 8 12 3 7 8'/>
                  <line x1='12' y1='3' x2='12' y2='15'/>
                </svg>
              </div>
              <p style={{ fontSize: 15, fontWeight: 600, color: C.textMid, margin: '0 0 4px' }}>Drop your claimant file here</p>
              <p style={{ fontSize: 13, color: C.textLight, margin: '0 0 22px' }}>CSV or VSC · max 10MB</p>
              <input type='file' accept='.csv,.vsc,.txt' onChange={handleFileUpload} style={{ display: 'none' }} id='outreach-file' />
              <label htmlFor='outreach-file'>
                <button disabled={loading} style={{
                  padding: '10px 28px', borderRadius: 9, border: 'none', cursor: 'pointer',
                  background: C.sage, color: '#fff', fontSize: 14, fontWeight: 600,
                  boxShadow: `0 3px 12px ${C.sage}40`,
                  transition: 'background 0.2s',
                }}>
                  {loading ? 'Analyzing…' : 'Choose file'}
                </button>
              </label>
            </div>

            {/* Channel toggles */}
            <div style={{ background: C.card, borderRadius: 18, padding: '22px 26px' }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: C.textLight, letterSpacing: 1.2, textTransform: 'uppercase', margin: '0 0 14px' }}>
                Channels to trigger
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                {channels.map(ch => {
                  const enabled = ch.key === 'email' ? emailEnabled : ch.key === 'sms' ? smsEnabled : voiceEnabled;
                  const setter = ch.key === 'email' ? setEmailEnabled : ch.key === 'sms' ? setSmsEnabled : setVoiceEnabled;
                  return (
                    <div key={ch.key} onClick={() => setter(!enabled)} style={{
                      borderRadius: 12, padding: '13px 14px', cursor: 'pointer',
                      border: `2px solid ${enabled ? ch.color : C.border}`,
                      background: enabled ? `${ch.color}14` : '#FAFAFA',
                      transition: 'all 0.2s',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                        <div style={{
                          width: 18, height: 18, borderRadius: 5, background: enabled ? ch.color : C.border,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {enabled && <svg width={9} height={9} viewBox='0 0 24 24' fill='none' stroke='#fff' strokeWidth={3}><polyline points='20 6 9 17 4 12'/></svg>}
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 600, color: enabled ? C.textMid : C.textLight }}>{ch.label}</span>
                      </div>
                      <p style={{ fontSize: 11, color: C.textMuted, margin: 0, lineHeight: 1.4 }}>{ch.desc}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Recent batches */}
            {batches.length > 0 && (
              <div style={{ background: C.card, borderRadius: 18, padding: '22px 26px' }}>
                <p style={{ fontSize: 11, fontWeight: 600, color: C.textLight, letterSpacing: 1.2, textTransform: 'uppercase', margin: '0 0 14px' }}>
                  Recent batches
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {batches.map(b => (
                    <div
                      key={b.id}
                      onClick={() => {
                        apiFetchRaw(`/api/outreach/batches/${b.id}`)
                          .then(r => r.ok ? r.json() : null)
                          .then(data => { if (data) { setActiveBatch(data as OutreachBatch); setStep(4); } })
                          .catch(() => {});
                      }}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', borderRadius: 10, background: C.bg, cursor: 'pointer', transition: 'background 0.15s' }}
                      onMouseOver={e => (e.currentTarget as HTMLElement).style.background = C.sageLight}
                      onMouseOut={e => (e.currentTarget as HTMLElement).style.background = C.bg}
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: C.textMid }}>{b.filename.replace(/^\u005boutreach\u005d /i, '')}</div>
                        <div style={{ fontSize: 11, color: C.textLight, marginTop: 2 }}>{new Date(b.created_at).toLocaleDateString()} · {b.total_rows} rows</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {b.success_count > 0 && (
                          <span style={{ fontSize: 12, color: C.success, fontWeight: 500 }}>{b.success_count} ok</span>
                        )}
                        {b.duplicate_count > 0 && (
                          <span style={{ fontSize: 12, color: C.warning }}>{b.duplicate_count} dup</span>
                        )}
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: b.status === 'completed' ? C.sage : C.warning, flexShrink: 0 }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* STEP 2 — Settings */}
        {step === 2 && preview && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* File summary */}
            <div style={{ background: C.card, borderRadius: 18, padding: '18px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: 14, fontWeight: 600, color: C.textMid, margin: 0 }}>{filename}</p>
                <p style={{ fontSize: 12, color: C.textLight, margin: '4px 0 0' }}>{preview.total_rows} claimants detected · {preview.headers.length} columns</p>
              </div>
              <button
                onClick={() => setStep(1)}
                style={{ fontSize: 12, color: C.textLight, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
              >Change</button>
            </div>

            {/* Case page URL */}
            <div style={{ background: C.card, borderRadius: 18, padding: '20px 26px' }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: C.textLight, letterSpacing: 1.2, textTransform: 'uppercase', margin: '0 0 10px' }}>
                Tort-specific page URL
              </p>
              <input
                type='url'
                value={tortPageUrl}
                onChange={e => setTortPageUrl(e.target.value)}
                placeholder='https://yourfirm.com/roundup-reintake'
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: 8, boxSizing: 'border-box',
                  border: `1.5px solid ${C.border}`, fontSize: 14, color: C.textDark,
                  background: C.sageLight, outline: 'none',
                  transition: 'border-color 0.2s',
                }}
                onFocus={e => (e.target.style.borderColor = C.sage)}
                onBlur={e => (e.target.style.borderColor = String(C.border))}
              />
              <p style={{ fontSize: 12, color: C.textLight, margin: '8px 0 0' }}>
                Each claimant will receive this page through the selected channels.
              </p>
            </div>

            {/* Active channels */}
            <div style={{ background: C.card, borderRadius: 18, padding: '18px 26px' }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: C.textLight, letterSpacing: 1.2, textTransform: 'uppercase', margin: '0 0 12px' }}>
                Active channels
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                {emailEnabled && (
                  <span style={{ padding: '5px 14px', borderRadius: 20, background: `${C.success}18`, color: C.success, fontSize: 12, fontWeight: 600 }}>
                    Email
                  </span>
                )}
                {smsEnabled && (
                  <span style={{ padding: '5px 14px', borderRadius: 20, background: `${C.blue}18`, color: C.blue, fontSize: 12, fontWeight: 600 }}>
                    SMS
                  </span>
                )}
                {voiceEnabled && (
                  <span style={{ padding: '5px 14px', borderRadius: 20, background: `${C.warm}18`, color: C.warm, fontSize: 12, fontWeight: 600 }}>
                    Voice via Vapi
                  </span>
                )}
              </div>
            </div>

            {/* Back + Launch */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setStep(1)}
                style={{ flex: 1, padding: '13px', borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, fontSize: 14, color: C.textMid, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' }}
                onMouseOver={e => (e.currentTarget as HTMLElement).style.background = C.sageLight}
                onMouseOut={e => (e.currentTarget as HTMLElement).style.background = C.card}
              >
                Back
              </button>
              <button
                onClick={handleStartOutreach}
                disabled={loading}
                style={{
                  flex: 3, padding: '13px', borderRadius: 10, border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
                  background: C.sage, color: '#fff', fontSize: 14, fontWeight: 700,
                  boxShadow: `0 4px 16px ${C.sage}40`,
                  transition: 'background 0.2s',
                  opacity: loading ? 0.7 : 1,
                }}
                onMouseOver={e => { if (!loading) (e.currentTarget as HTMLElement).style.background = C.sageDark; }}
                onMouseOut={e => (e.currentTarget as HTMLElement).style.background = C.sage}
              >
                {loading ? 'Launching…' : `Launch to ${preview.total_rows} claimants`}
              </button>
            </div>
          </div>
        )}

        {/* STEP 3 — Running */}
        {step === 3 && activeBatch && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ background: C.card, borderRadius: 18, padding: '36px 28px', textAlign: 'center' }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, background: C.sageLight, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', border: `3px solid ${C.sage}`, borderTopColor: 'transparent', animation: 'outreachSpin 1s linear infinite' }} />
              </div>
              <p style={{ fontSize: 16, fontWeight: 600, color: C.textMid, margin: '0 0 5px' }}>Outreach in progress</p>
              <p style={{ fontSize: 13, color: C.textLight, margin: 0 }}>
                Importing leads, then dispatching {emailEnabled ? 'email' : ''}{smsEnabled ? ' · SMS' : ''}{voiceEnabled ? ' · Voice' : ''}
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {[
                { label: 'Rows', val: `${activeBatch.processed_rows}/${activeBatch.total_rows}` },
                { label: 'Imported', val: activeBatch.success_count, color: C.success },
                { label: 'Duplicates', val: activeBatch.duplicate_count, color: C.warning },
                { label: 'Errors', val: activeBatch.error_count, color: C.danger },
              ].map(s => (
                <div key={s.label} style={{ background: C.card, borderRadius: 14, padding: '18px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: s.color ?? C.textMid }}>{s.val}</div>
                  <div style={{ fontSize: 10, color: C.textLight, marginTop: 5, textTransform: 'uppercase', letterSpacing: 0.8 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* STEP 4 — Results */}
        {step === 4 && activeBatch && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ background: C.card, borderRadius: 18, padding: '32px 28px', textAlign: 'center' }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, background: C.sageLight, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <svg width={24} height={24} viewBox='0 0 24 24' fill='none' stroke={C.sage} strokeWidth={2.5} strokeLinecap='round' strokeLinejoin='round'>
                  <polyline points='20 6 9 17 4 12'/>
                </svg>
              </div>
              <p style={{ fontSize: 18, fontWeight: 700, color: C.textMid, margin: '0 0 5px' }}>Outreach complete</p>
              <p style={{ fontSize: 13, color: C.textLight, margin: 0 }}>{filename}</p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              {[
                { label: 'Imported / updated', val: activeBatch.success_count, color: C.success },
                { label: 'Duplicates skipped', val: activeBatch.duplicate_count, color: C.warning },
                { label: 'Errors', val: activeBatch.error_count, color: C.danger },
              ].map(s => (
                <div key={s.label} style={{ background: C.card, borderRadius: 14, padding: '22px 16px', textAlign: 'center' }}>
                  <div style={{ fontSize: 36, fontWeight: 700, color: s.color }}>{s.val}</div>
                  <div style={{ fontSize: 11, color: C.textLight, marginTop: 8 }}>{s.label}</div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={reset}
                style={{ flex: 1, padding: '13px', borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, fontSize: 14, color: C.textMid, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' }}
                onMouseOver={e => (e.currentTarget as HTMLElement).style.background = C.sageLight}
                onMouseOut={e => (e.currentTarget as HTMLElement).style.background = C.card}
              >
                New batch
              </button>
              <Link
                href='/dialer'
                style={{ flex: 1, padding: '13px', borderRadius: 10, background: C.sage, fontSize: 14, color: '#fff', fontWeight: 600, textDecoration: 'none', textAlign: 'center', boxShadow: `0 3px 12px ${C.sage}40`, transition: 'background 0.2s' }}
                onMouseOver={e => (e.currentTarget as HTMLElement).style.background = C.sageDark}
                onMouseOut={e => (e.currentTarget as HTMLElement).style.background = C.sage}
              >
                View dialer
              </Link>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes outreachSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}