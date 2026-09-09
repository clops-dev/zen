import { Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { copyToClipboard } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
}

export const CopyButton = ({ text, label = 'Copy', className = '' }: CopyButtonProps) => {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      toast({ title: 'Copied', description: label, variant: 'success' });
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-border bg-bg-subtle hover:bg-bg-card hover:border-border-strong transition-colors btn-press ${className}`}
    >
      {copied ? <Check size={11} className="text-brand" /> : <Copy size={11} />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
};
