import React from 'react';
import { Sparkles } from 'lucide-react';

interface ComingSoonProps {
  title: string;
  description: string;
}

export function ComingSoonPage({ title, description }: ComingSoonProps) {
  return (
    <div className="bg-card border border-border rounded-xl p-16 text-center max-w-2xl mx-auto space-y-4 my-8">
      <div className="w-12 h-12 rounded-full bg-sky-950 border border-sky-800 flex items-center justify-center mx-auto text-sky-400">
        <Sparkles className="w-6 h-6" />
      </div>
      <div className="inline-block px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-300 uppercase tracking-wider">
        Coming next in Prompt 9/11
      </div>
      <h2 className="text-xl font-bold text-slate-100">{title}</h2>
      <p className="text-sm text-muted leading-relaxed">{description}</p>
    </div>
  );
}

