import type { ReactNode } from 'react';

export function Notice({ tone, title, children, action }: { tone: 'warn' | 'bad' | 'info'; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <div className="notice-body">
        {title && <p className="notice-title">{title}</p>}
        {children && <div>{children}</div>}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}
