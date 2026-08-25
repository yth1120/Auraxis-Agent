// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DiffView from '../DiffView';

describe('DiffView', () => {
  const oldContent = 'function foo() {\n  return 1;\n}\n';
  const newContent = 'function foo() {\n  return 2;\n  console.log("new");\n}\n';

  it('renders split mode by default with a 2-column grid', () => {
    const { container } = render(<DiffView oldContent={oldContent} newContent={newContent} fileName="foo.ts" />);
    // Split mode renders rows with grid-cols-2
    const rows = container.querySelectorAll('[class*="grid-cols-2"]');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('toggle button switches to unified mode', () => {
    const { container } = render(<DiffView oldContent={oldContent} newContent={newContent} fileName="foo.ts" />);
    expect(container.querySelectorAll('[class*="grid-cols-2"]').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('统一'));
    // Unified mode: no grid-cols-2 rows, uses bg-success-soft / bg-danger-soft lines
    expect(container.querySelectorAll('[class*="grid-cols-2"]').length).toBe(0);
    const diffLines = container.querySelectorAll('[class*="bg-success-soft"], [class*="bg-danger-soft"]');
    expect(diffLines.length).toBeGreaterThan(0);
  });

  it('respects an explicit mode="unified" prop', () => {
    const { container } = render(
      <DiffView oldContent={oldContent} newContent={newContent} fileName="foo.ts" mode="unified" />,
    );
    expect(container.querySelectorAll('[class*="grid-cols-2"]').length).toBe(0);
    const diffLines = container.querySelectorAll('[class*="bg-success-soft"], [class*="bg-danger-soft"]');
    expect(diffLines.length).toBeGreaterThan(0);
  });

  it('shows a "new file" banner when oldContent is empty', () => {
    const { getByText } = render(<DiffView oldContent="" newContent="hello\nworld" fileName="new.txt" />);
    expect(getByText(/新建文件/)).toBeTruthy();
  });

  it('applies syntax highlighting for .ts files (hljs spans present)', () => {
    const { container } = render(<DiffView oldContent="const x = 1;" newContent="const x = 2;" fileName="foo.ts" />);
    // Look for hljs token spans rendered via dangerouslySetInnerHTML
    const html = container.innerHTML;
    expect(html).toMatch(/class="hljs-keyword"/);
  });

  it('renders nothing when both contents are empty', () => {
    const { container } = render(<DiffView oldContent="" newContent="" />);
    expect(container.firstChild).toBeNull();
  });

  it('pairs a removal-with-addition into a single split row (modify)', () => {
    // One line changes: "return 1" → "return 2". In split mode, this should be
    // a single row with both sides populated (a "modify" row), not two stacked
    // rows. We detect this by counting unique grid rows that have BOTH a
    // remove- and add-coloured cell (via bg-danger-soft + bg-success-soft).
    const { container } = render(
      <DiffView
        oldContent="function foo() {\n  return 1;\n}"
        newContent="function foo() {\n  return 2;\n}"
        fileName="foo.ts"
      />,
    );
    const rows = Array.from(container.querySelectorAll('[class*="grid-cols-2"]'));
    const modifyRows = rows.filter(
      (r) => r.querySelector('[class*="bg-danger-soft"]') && r.querySelector('[class*="bg-success-soft"]'),
    );
    expect(modifyRows.length).toBe(1);
  });
});
