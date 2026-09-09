import { useState, useEffect } from 'react';
import { User, Shield, Sliders, Bell, Monitor, Smartphone, LogOut, Key, CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Tabs, Select, Checkbox, Input } from '@/components/ui/form';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/useToast';
import { useAuth } from '@/hooks/useAuth';

const tabItems = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'preferences', label: 'Preferences', icon: Sliders },
  { id: 'notifications', label: 'Notifications', icon: Bell },
];

export const SettingsPage = () => {
  const { toast } = useToast();
  const { user, logout } = useAuth();
  const [tab, setTab] = useState('profile');

  const [profile, setProfile] = useState({
    username: user?.email ? user.email.split('@')[0] : 'developer',
    email: user?.email || '',
    bio: 'Software engineer building with Zencode.',
  });

  useEffect(() => {
    if (user?.email) {
      setProfile((p) => ({
        ...p,
        email: user.email,
        username: user.email.split('@')[0],
      }));
    }
  }, [user]);

  const saveProfile = () => {
    toast({ title: 'Profile Updated', description: 'Your profile settings have been saved.', variant: 'success' });
  };

  const [passwords, setPasswords] = useState({ current: '', new: '', confirm: '' });
  const [twoFA, setTwoFA] = useState(true);

  const changePassword = () => {
    toast({
      title: 'Google OAuth Protected',
      description: 'Your account is authenticated via Google. Password changes should be made in your Google account.',
      variant: 'default',
    });
  };

  const [prefs, setPrefs] = useState({
    defaultModel: 'qwen-coder',
    theme: 'dark',
    terminalFont: 'jetbrains',
    cursorStyle: 'block',
    autoUpdate: true,
  });

  const [notifs, setNotifs] = useState({
    email: true,
    billing: true,
    security: true,
    updates: false,
    marketing: false,
  });

  const sessions = [
    { device: 'This Browser', location: 'Current Session', ip: '—', current: true, icon: Monitor },
    { device: 'Zencode CLI', location: 'API Key Auth', ip: '—', current: false, icon: Smartphone },
  ];


  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] text-fg-subtle uppercase tracking-widest mb-1">~/settings</div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-fg-muted mt-1">
          Manage your account, security and preferences.
        </p>
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="border-b border-border">
          <div className="flex items-center gap-0 overflow-x-auto">
            {tabItems.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`relative flex items-center gap-2 px-5 py-3 text-xs font-bold uppercase tracking-wider transition-colors whitespace-nowrap ${
                  tab === t.id ? 'text-fg' : 'text-fg-muted hover:text-fg'
                }`}
              >
                <t.icon size={13} />
                {t.label}
                {tab === t.id && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand" />
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6">
          {tab === 'profile' && (
            <div className="space-y-5 max-w-xl">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
                  Username
                </label>
                <Input
                  value={profile.username}
                  onChange={(v) => setProfile({ ...profile, username: v })}
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
                  Email
                </label>
                <Input
                  type="email"
                  value={profile.email}
                  onChange={(v) => setProfile({ ...profile, email: v })}
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
                  Bio
                </label>
                <textarea
                  value={profile.bio}
                  onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 text-xs bg-bg-subtle border border-border rounded-md placeholder:text-fg-subtle focus:border-brand focus:outline-none transition-colors resize-none"
                />
              </div>
              <button
                onClick={saveProfile}
                className="px-5 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
              >
                Save Changes
              </button>
            </div>
          )}

          {tab === 'security' && (
            <div className="space-y-6 max-w-2xl">
              <Card className="p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Key size={14} className="text-brand" />
                  <span className="text-xs font-bold tracking-wider">CHANGE PASSWORD</span>
                </div>
                <div className="space-y-3">
                  <Input
                    type="password"
                    value={passwords.current}
                    onChange={(v) => setPasswords({ ...passwords, current: v })}
                    placeholder="Current password"
                  />
                  <Input
                    type="password"
                    value={passwords.new}
                    onChange={(v) => setPasswords({ ...passwords, new: v })}
                    placeholder="New password"
                  />
                  <Input
                    type="password"
                    value={passwords.confirm}
                    onChange={(v) => setPasswords({ ...passwords, confirm: v })}
                    placeholder="Confirm new password"
                  />
                  <button
                    onClick={changePassword}
                    className="px-4 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
                  >
                    Update Password
                  </button>
                </div>
              </Card>

              <Card className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <Shield size={14} className="text-brand" />
                      <span className="text-xs font-bold tracking-wider">TWO-FACTOR AUTHENTICATION</span>
                    </div>
                    <p className="text-[11px] text-fg-muted mt-1">Add an extra layer of security</p>
                  </div>
                  <button
                    onClick={() => {
                      setTwoFA(!twoFA);
                      toast({
                        title: twoFA ? '2FA Disabled' : '2FA Enabled',
                        variant: twoFA ? 'warning' : 'success',
                      });
                    }}
                    className={`relative w-12 h-6 rounded-full transition-colors ${
                      twoFA ? 'bg-brand' : 'bg-bg-subtle border border-border'
                    }`}
                  >
                    <div
                      className={`absolute top-0.5 w-5 h-5 rounded-full transition-transform ${
                        twoFA ? 'translate-x-6 bg-black' : 'translate-x-0.5 bg-fg-muted'
                      }`}
                    />
                  </button>
                </div>
                {twoFA && (
                  <Badge variant="success" dot className="mt-2">
                    Active
                  </Badge>
                )}
              </Card>

              <Card className="p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Monitor size={14} className="text-brand" />
                  <span className="text-xs font-bold tracking-wider">ACTIVE SESSIONS</span>
                </div>
                <div className="space-y-2">
                  {sessions.map((s, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 p-3 bg-bg-subtle border border-border rounded"
                    >
                      <s.icon size={18} className="text-fg-muted" />
                      <div className="flex-1">
                        <div className="text-xs font-bold flex items-center gap-2">
                          {s.device}
                          {s.current && (
                            <Badge variant="success" dot>
                              Current
                            </Badge>
                          )}
                        </div>
                        <div className="text-[10px] text-fg-subtle">
                          {s.location} · {s.ip}
                        </div>
                      </div>
                      {!s.current && (
                        <button
                          onClick={() => toast({ title: 'Session Revoked', variant: 'warning' })}
                          className="text-[10px] font-bold uppercase tracking-wider text-red-400 hover:text-red-300"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          {tab === 'preferences' && (
            <div className="space-y-5 max-w-xl">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
                  Default Model
                </label>
                <Select
                  value={prefs.defaultModel}
                  onChange={(v) => setPrefs({ ...prefs, defaultModel: v })}
                  options={[
                    { label: 'Qwen Coder', value: 'qwen-coder' },
                    { label: 'Claude', value: 'claude' },
                    { label: 'GPT-4', value: 'gpt-4' },
                    { label: 'DeepSeek Coder', value: 'deepseek-coder' },
                  ]}
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
                  Theme
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {['dark', 'midnight', 'crimson'].map((t) => (
                    <button
                      key={t}
                      onClick={() => setPrefs({ ...prefs, theme: t })}
                      className={`p-3 border text-xs font-bold uppercase tracking-wider rounded transition-colors ${
                        prefs.theme === t
                          ? 'border-brand bg-brand/10 text-fg'
                          : 'border-border text-fg-muted hover:bg-bg-card'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
                  Terminal Font
                </label>
                <Select
                  value={prefs.terminalFont}
                  onChange={(v) => setPrefs({ ...prefs, terminalFont: v })}
                  options={[
                    { label: 'JetBrains Mono', value: 'jetbrains' },
                    { label: 'Fira Code', value: 'fira' },
                    { label: 'Cascadia Code', value: 'cascadia' },
                  ]}
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-2">
                  Cursor Style
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {['block', 'underline', 'bar'].map((c) => (
                    <button
                      key={c}
                      onClick={() => setPrefs({ ...prefs, cursorStyle: c })}
                      className={`p-3 border text-xs font-bold uppercase tracking-wider rounded transition-colors ${
                        prefs.cursorStyle === c
                          ? 'border-brand bg-brand/10 text-fg'
                          : 'border-border text-fg-muted hover:bg-bg-card'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <div className="pt-2">
                <Checkbox
                  checked={prefs.autoUpdate}
                  onChange={(v) => setPrefs({ ...prefs, autoUpdate: v })}
                  label="Auto-update CLI to latest version"
                />
              </div>
              <button
                onClick={() => toast({ title: 'Preferences Saved', variant: 'success' })}
                className="px-5 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
              >
                Save Preferences
              </button>
            </div>
          )}

          {tab === 'notifications' && (
            <div className="space-y-3 max-w-xl">
              {[
                { key: 'email', label: 'Email Notifications', desc: 'Receive notifications via email' },
                { key: 'billing', label: 'Billing Alerts', desc: 'Payment and usage alerts' },
                { key: 'security', label: 'Security Alerts', desc: 'New logins and suspicious activity' },
                { key: 'updates', label: 'Product Updates', desc: 'New features and improvements' },
                { key: 'marketing', label: 'Marketing', desc: 'Tips, news and special offers' },
              ].map((n) => {
                const checked = notifs[n.key as keyof typeof notifs];
                return (
                  <div
                    key={n.key}
                    className="flex items-center justify-between p-4 bg-bg-subtle border border-border rounded"
                  >
                    <div>
                      <div className="text-xs font-bold">{n.label}</div>
                      <div className="text-[11px] text-fg-muted">{n.desc}</div>
                    </div>
                    <button
                      onClick={() => setNotifs({ ...notifs, [n.key]: !checked })}
                      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
                        checked ? 'bg-brand' : 'bg-bg-card border border-border'
                      }`}
                    >
                      <div
                        className={`absolute top-0.5 w-5 h-5 rounded-full transition-transform ${
                          checked ? 'translate-x-5 bg-black' : 'translate-x-0.5 bg-fg-muted'
                        }`}
                      />
                    </button>
                  </div>
                );
              })}
              <button
                onClick={() => toast({ title: 'Notification Settings Saved', variant: 'success' })}
                className="px-5 py-2 bg-brand text-black text-xs font-bold uppercase tracking-wider rounded hover:bg-brand-hover btn-press"
              >
                Save Notification Settings
              </button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
