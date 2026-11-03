import {useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {Brain, BrainCircuit, Check, ChevronDown, Sparkles, Zap} from 'lucide-react';
import type {ReasoningEffort} from '@tada/client-core';

const modes = [
  {value: 'off', label: '思考关闭', detail: '直接回答，轻快交流', icon: Zap},
  {value: 'low', label: '轻度思考', detail: '多想一步，理清日常问题', icon: Brain},
  {value: 'high', label: '深度思考', detail: '仔细分析，适合复杂问题', icon: BrainCircuit},
  {value: 'max', label: '尽力思考', detail: '更充分地推敲，可能需要更久', icon: Sparkles},
] as const;

type MenuPosition = Pick<CSSProperties, 'left' | 'top' | 'width' | 'maxHeight'>;

/** One accessible menu. This only selects the existing wire value, never sends. */
export function ReasoningMenu({value, onChange, disabled = false}: {value: ReasoningEffort; onChange(value: ReasoningEffort): void; disabled?: boolean}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, modes.findIndex(mode => mode.value === value)));
  const [position, setPosition] = useState<MenuPosition>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const selected = Math.max(0, modes.findIndex(mode => mode.value === value));
  const current = modes[selected];

  function dismiss(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({preventScroll: true});
  }
  function show(index = selected) {
    if (disabled) return;
    setActive(index); setOpen(true);
  }
  function focusItem(index: number) {
    setActive(index);
    items.current[index]?.focus({preventScroll: true});
    items.current[index]?.scrollIntoView?.({block: 'nearest'});
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); focusItem((active + (event.key === 'ArrowDown' ? 1 : -1) + modes.length) % modes.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); focusItem(event.key === 'Home' ? 0 : modes.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); dismiss();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const focusable = Array.from(document.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]')).filter(element => {
        if (element.tabIndex < 0 || panel.current?.contains(element) || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      const index = trigger.current ? focusable.indexOf(trigger.current) : -1;
      const target = index >= 0 ? focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length] : trigger.current;
      dismiss(false); target?.focus({preventScroll: true});
    }
  }

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const width = Math.min(300, Math.max(160, viewportWidth - 24));
      const maxHeight = Math.max(72, rect.top - 20);
      const height = Math.min(panel.current?.scrollHeight || 307, maxHeight);
      setPosition({left: Math.max(12, Math.min(rect.left, viewportWidth - width - 12)), top: Math.max(10, rect.top - height - 10), width, maxHeight});
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    items.current[active]?.focus({preventScroll: true});
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) dismiss(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  useEffect(() => {if (disabled && open) dismiss(false);}, [disabled, open]);

  return <>
    <button ref={trigger} type="button" className={`reasoning-trigger ${value !== 'off' ? 'enabled' : ''} ${open ? 'is-open' : ''}`} aria-label={`思考模式：${current.label}`} aria-haspopup="menu" aria-controls={open ? menuId : undefined} aria-expanded={open} disabled={disabled} onClick={() => open ? dismiss() : show()} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {event.preventDefault(); show(event.key === 'ArrowDown' ? 0 : modes.length - 1);}
      else if (event.key === 'Escape' && open) {event.preventDefault(); dismiss();}
    }}><Brain size={15}/><span>{current.label}</span><ChevronDown className="reasoning-chevron" size={12}/></button>
    {open && createPortal(<div id={menuId} ref={panel} className="reasoning-panel" role="menu" aria-label="思考模式" style={position} onKeyDown={keyDown}>
      <div className="reasoning-menu-heading"><span>思考模式</span><small>按问题选择，随时切换</small></div>
      <div className="reasoning-options">{modes.map((mode, index) => {
        const Icon = mode.icon;
        return <button key={mode.value} ref={element => {items.current[index] = element;}} type="button" role="menuitemradio" aria-checked={mode.value === value} aria-label={`${mode.label}，${mode.detail}`} tabIndex={active === index ? 0 : -1} className={`reasoning-option ${mode.value === value ? 'selected' : ''}`} onFocus={() => setActive(index)} onClick={() => {onChange(mode.value); dismiss();}}>
          <span className={`reasoning-option-icon mode-${mode.value}`}><Icon size={17}/></span><span className="reasoning-option-text"><strong>{mode.label}</strong><small>{mode.detail}</small></span><span className="reasoning-option-check" aria-hidden="true">{mode.value === value && <Check size={16}/>}</span>
        </button>;
      })}</div>
      <div className="reasoning-menu-footnote">仅影响接下来发送的消息</div>
    </div>, document.body)}
  </>;
}
