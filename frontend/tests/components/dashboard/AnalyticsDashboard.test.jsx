import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalyticsDashboard from '../../../components/dashboard/AnalyticsDashboard';

const SUMMARY_RESPONSE = {
  totalEscrows: 42,
  totalXLMVolume: '1000',
  disputeRate: 0.1,
  avgResolutionHours: 12,
  dailyBreakdown: [{ date: '2026-08-01', count: 3 }],
};

function mockFetchSequence(summaryResponse, cohortResponse) {
  global.fetch = jest.fn((url) => {
    const body = url.includes('/cohort') ? cohortResponse : summaryResponse;
    return Promise.resolve({ json: () => Promise.resolve(body) });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AnalyticsDashboard', () => {
  it('renders KPI tiles once summary and cohort data load', async () => {
    mockFetchSequence(SUMMARY_RESPONSE, { weeks: [1, 2], retention: [90, 80] });
    render(<AnalyticsDashboard />);
    expect(screen.getByText(/Loading analytics/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Analytics Dashboard')).toBeInTheDocument());
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  // Regression test: the /cohort endpoint resolving to `null` (no cohort
  // data yet) used to crash the component with
  // "Cannot read properties of null (reading 'weeks')" because
  // `Array.isArray(c.weeks)` read `.weeks` directly off `c` without an
  // optional-chain guard, even though the sibling line right below it
  // (`c.retention?.[i]`) already used one. The thrown error was silently
  // swallowed by the outer `.catch`, so instead of showing an empty
  // cohort chart the whole dashboard fell into the generic error state.
  it('does not crash and shows the dashboard (not an error) when the cohort endpoint resolves to null', async () => {
    mockFetchSequence(SUMMARY_RESPONSE, null);
    render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('Analytics Dashboard')).toBeInTheDocument());
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('falls back to an empty cohort array when the cohort payload has an unexpected shape', async () => {
    mockFetchSequence(SUMMARY_RESPONSE, { unexpectedShape: true });
    render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('Analytics Dashboard')).toBeInTheDocument());
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('shows an error state when a request actually fails', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('Network down')));
    render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText(/Error: Network down/i)).toBeInTheDocument());
  });
});
