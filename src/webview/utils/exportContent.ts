/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file exportContent.ts - Extract and prepare content for export
 * @description Collects HTML content from the editor and converts Mermaid SVGs
 * to PNG images for high-quality export to PDF/Word.
 */

import { Editor } from '@tiptap/core';

/**
 * Export content data structure
 */
export interface ExportContent {
  html: string;
  mermaidImages: Array<{
    id: string;
    pngDataUrl: string;
    originalSvg: string;
  }>;
}

/**
 * Collect HTML content and Mermaid diagrams from the editor
 *
 * @param editor - TipTap editor instance
 * @returns Export-ready content with HTML and Mermaid PNGs
 */
export async function collectExportContent(editor: Editor): Promise<ExportContent> {
  // Get HTML content from editor
  const editorElement = editor.view.dom as HTMLElement;
  const clonedContent = editorElement.cloneNode(true) as HTMLElement;

  // Comment and wrapper-tag markers are source shown for editing, not document content.
  clonedContent.querySelectorAll('.md4h-html-comment').forEach(marker => marker.remove());

  // Find all Mermaid diagrams
  const mermaidWrappers = clonedContent.querySelectorAll('.mermaid-wrapper');
  const mermaidImages: ExportContent['mermaidImages'] = [];

  // Convert each Mermaid SVG to PNG
  for (let i = 0; i < mermaidWrappers.length; i++) {
    const wrapper = mermaidWrappers[i] as HTMLElement;
    const renderDiv = wrapper.querySelector('.mermaid-render') as HTMLElement;

    if (renderDiv) {
      const svgElement = renderDiv.querySelector('svg');

      if (svgElement) {
        try {
          // Convert SVG to PNG
          const pngDataUrl = await svgToPng(svgElement);
          const id = `mermaid-${i}`;

          mermaidImages.push({
            id,
            pngDataUrl,
            originalSvg: svgElement.outerHTML,
          });

          // Replace SVG with img tag in cloned content
          const imgElement = document.createElement('img');
          imgElement.src = pngDataUrl;
          imgElement.alt = `Mermaid diagram ${i + 1}`;
          imgElement.className = 'mermaid-export-image';
          imgElement.setAttribute('data-mermaid-id', id);

          // Replace the mermaid-wrapper with the image
          wrapper.parentNode?.replaceChild(imgElement, wrapper);
        } catch (error) {
          console.error('Failed to convert Mermaid SVG to PNG:', error);
          // Keep the SVG as fallback
        }
      }
    }
  }

  const finalHtml = clonedContent.innerHTML;

  return {
    html: finalHtml,
    mermaidImages,
  };
}

/**
 * Convert SVG element to PNG data URL
 *
 * @param svgElement - SVG DOM element
 * @returns PNG image as data URL
 */
async function svgToPng(svgElement: SVGSVGElement): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      // Get SVG dimensions
      const bbox = svgElement.getBoundingClientRect();
      const width = bbox.width || 800;
      const height = bbox.height || 600;

      // Create canvas
      const canvas = document.createElement('canvas');
      const scale = 2; // 2x for high quality
      canvas.width = width * scale;
      canvas.height = height * scale;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      // Scale for high quality
      ctx.scale(scale, scale);

      // White background for PDFs
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      // Convert SVG to image using data URL (avoids canvas tainting from blob URLs)
      const svgData = new XMLSerializer().serializeToString(svgElement);
      const encodedSvgData = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);

      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, width, height);

        // Convert canvas to PNG
        const pngDataUrl = canvas.toDataURL('image/png');
        resolve(pngDataUrl);
      };

      img.onerror = () => {
        reject(new Error('Failed to load SVG as image'));
      };

      img.src = encodedSvgData;
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Get document title from editor content
 * Looks for first H1 heading, falls back to filename
 *
 * @param editor - TipTap editor instance
 * @returns Document title
 */
export function getDocumentTitle(editor: Editor): string {
  // Find first H1 heading
  const firstHeading = editor.view.dom.querySelector('h1');
  if (firstHeading && firstHeading.textContent) {
    return firstHeading.textContent.trim();
  }

  // Fallback to "Untitled Document"
  return 'Untitled Document';
}
