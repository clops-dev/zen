import { useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight, BookOpen } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { CopyButton } from '@/components/ui/copy-button';
import { mockDocs } from '@/data/mockData';

const renderMarkdown = (md: string) => {
  const lines = md.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.replace('```', '').trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        <div key={key++} className="my-3 bg-black/60 border border-border rounded-md overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 bg-bg-subtle border-b border-border">
            <span className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">
              {lang || 'bash'}
            </span>
            <CopyButton text={codeLines.join('\n')} label="Copy" />
          </div>
          <pre className="p-4 overflow-x-auto text-xs font-mono text-fg">
            <code>{codeLines.join('\n')}</code>
          </pre>
        </div>
      );
      continue;
    }

    if (line.startsWith('# ')) {
      out.push(
        <h1 key={key++} className="text-2xl font-bold tracking-tight mt-2 mb-4">
          {line.slice(2)}
        </h1>
      );
      i++;
      continue;
    }

    if (line.startsWith('## ')) {
      out.push(
        <h2 key={key++} className="text-lg font-bold mt-6 mb-3 pb-2 border-b border-border">
          {line.slice(3)}
        </h2>
      );
      i++;
      continue;
    }

    if (line.startsWith('### ')) {
      out.push(
        <h3 key={key++} className="text-sm font-bold uppercase tracking-wider mt-4 mb-2 text-fg-muted">
          {line.slice(4)}
        </h3>
      );
      i++;
      continue;
    }

    if (line.trim() === '') {
      out.push(<div key={key++} className="h-2" />);
      i++;
      continue;
    }

    out.push(
      <p key={key++} className="text-sm text-fg-muted leading-relaxed my-2">
        {line}
      </p>
    );
    i++;
  }

  return out;
};

export const DocsPage = () => {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    return mockDocs.filter(
      (d) =>
        d.title.toLowerCase().includes(search.toLowerCase()) ||
        d.content.toLowerCase().includes(search.toLowerCase())
    );
  }, [search]);

  const currentSlug = slug || mockDocs[0].slug;
  const current = mockDocs.find((d) => d.slug === currentSlug) || mockDocs[0];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] text-fg-subtle uppercase tracking-widest mb-1">~/docs</div>
          <h1 className="text-2xl font-bold tracking-tight">Documentation</h1>
          <p className="text-sm text-fg-muted mt-1">
            Learn how to install, configure and use the Zencode CLI.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
          <Input
            value={search}
            onChange={setSearch}
            placeholder="Search docs..."
            className="pl-9"
          />
        </div>
      </div>

      <div className="grid lg:grid-cols-[240px_1fr] gap-4">
        {/* Sidebar nav */}
        <Card className="p-3 h-fit lg:sticky lg:top-20">
          <div className="space-y-1">
            {filtered.length === 0 ? (
              <div className="text-xs text-fg-subtle text-center py-6">No results</div>
            ) : (
              filtered.map((d) => (
                <button
                  key={d.slug}
                  onClick={() => navigate(`/docs/${d.slug}`)}
                  className={`w-full text-left px-3 py-2 text-xs rounded transition-colors ${
                    current.slug === d.slug
                      ? 'bg-brand/10 text-brand border border-brand/30 font-bold'
                      : 'text-fg-muted hover:bg-bg-card hover:text-fg border border-transparent'
                  }`}
                >
                  {d.title}
                </button>
              ))
            )}
          </div>
        </Card>

        {/* Content */}
        <Card className="p-6 lg:p-8 min-h-[500px]">
          <div className="flex items-center gap-2 text-[10px] text-fg-subtle uppercase tracking-wider mb-4">
            <BookOpen size={11} />
            <span>{current.group}</span>
            <span>›</span>
            <span className="text-brand">{current.title}</span>
          </div>

          {renderMarkdown(current.content)}

          <div className="flex items-center justify-between mt-8 pt-6 border-t border-border">
            {current.prev ? (
              <Link
                to={`/docs/${current.prev}`}
                className="flex items-center gap-2 text-xs text-fg-muted hover:text-brand transition-colors"
              >
                <ChevronLeft size={14} />
                <span>{mockDocs.find((d) => d.slug === current.prev)?.title || 'Previous'}</span>
              </Link>
            ) : (
              <div />
            )}
            {current.next ? (
              <Link
                to={`/docs/${current.next}`}
                className="flex items-center gap-2 text-xs text-fg-muted hover:text-brand transition-colors"
              >
                <span>{mockDocs.find((d) => d.slug === current.next)?.title || 'Next'}</span>
                <ChevronRight size={14} />
              </Link>
            ) : (
              <div />
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
