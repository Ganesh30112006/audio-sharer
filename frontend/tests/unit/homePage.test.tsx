import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import HomePage from '../../src/pages/HomePage';

describe('HomePage', () => {
  it('normalises room codes and only enables join for valid ones', async () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/room/:code" element={<p>joined room</p>} />
        </Routes>
      </MemoryRouter>,
    );
    const input = screen.getByLabelText('Room code');
    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toBeDisabled();
    await userEvent.type(input, 'ab-c2');
    expect(input).toHaveValue('ABC2');
    expect(button).toBeDisabled();
    await userEvent.type(input, '34');
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(screen.getByText('joined room')).toBeInTheDocument();
  });

  it('shows an error when the server is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
  });
});
