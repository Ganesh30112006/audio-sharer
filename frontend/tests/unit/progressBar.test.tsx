import { Profiler } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProgressBar } from '../../src/components/ProgressBar';

describe('ProgressBar', () => {
  it('updates the DOM while playing without re-rendering React', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    let t = 0;
    const onRender = vi.fn();
    render(
      <Profiler id="pb" onRender={onRender}>
        <ProgressBar getTime={() => t} duration={120} active onSeek={() => undefined} />
      </Profiler>,
    );
    const renders = onRender.mock.calls.length;
    for (let i = 0; i < 40; i++) {
      t += 0.1;
      await act(async () => {
        vi.advanceTimersByTime(50);
      });
    }
    expect(onRender.mock.calls.length).toBe(renders);
    const slider = screen.getByRole('slider', { name: 'Playback position' }) as HTMLInputElement;
    expect(Number(slider.value)).toBeGreaterThan(3);
    expect(screen.getByText(/0:0[34]/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('is not seekable for live sources', () => {
    render(<ProgressBar getTime={() => 0} duration={null} active={false} />);
    expect(screen.getByRole('slider')).toBeDisabled();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });
});
