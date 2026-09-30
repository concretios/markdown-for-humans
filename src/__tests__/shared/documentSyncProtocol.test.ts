import {
  DOCUMENT_SYNC_PROTOCOL_VERSION,
  parseDocumentEditAck,
  parseDocumentEditIdentity,
  parseDocumentEditMessage,
  parseDocumentFlushAck,
  parseDocumentFlushBarrier,
  parseDocumentSyncReady,
  parseDocumentTeardownEditMessage,
} from '../../shared/documentSyncProtocol';

describe('document sync protocol', () => {
  const validEdit = {
    type: 'edit',
    protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
    editId: 'view-a:12:3',
    viewGeneration: 'view-a',
    localRevision: 12,
    baseDocumentVersion: 7,
    content: '# Latest\n',
    editReason: 'typing',
  } as const;

  it('parses a fully correlated renderer edit', () => {
    expect(parseDocumentEditMessage(validEdit)).toEqual(validEdit);
  });

  it('retains a usable edit identity when the payload itself is malformed', () => {
    expect(parseDocumentEditIdentity({ ...validEdit, content: 42 }, 'edit')).toEqual({
      editId: validEdit.editId,
      viewGeneration: validEdit.viewGeneration,
      localRevision: validEdit.localRevision,
    });
    expect(parseDocumentEditIdentity({ ...validEdit, content: 42, editId: '' }, 'edit')).toBeNull();
  });

  it.each([
    ['wrong protocol', { ...validEdit, protocolVersion: 1 }],
    ['missing edit id', { ...validEdit, editId: '' }],
    ['missing generation', { ...validEdit, viewGeneration: '' }],
    ['negative local revision', { ...validEdit, localRevision: -1 }],
    ['fractional base version', { ...validEdit, baseDocumentVersion: 1.5 }],
    ['unknown reason', { ...validEdit, editReason: 'recovery' }],
    ['non-string content', { ...validEdit, content: 42 }],
  ])('rejects %s', (_, value) => {
    expect(parseDocumentEditMessage(value)).toBeNull();
  });

  it('parses one correlated applied edit acknowledgement', () => {
    const ack = {
      type: 'document.edit.ack',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      editId: validEdit.editId,
      viewGeneration: validEdit.viewGeneration,
      localRevision: validEdit.localRevision,
      accepted: true,
      documentVersion: 8,
    } as const;

    expect(parseDocumentEditAck(ack)).toEqual(ack);
  });

  it('parses a renderer generation ready handshake', () => {
    const ready = {
      type: 'ready',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      viewGeneration: 'view-ready-1',
    } as const;

    expect(parseDocumentSyncReady(ready)).toEqual(ready);
    expect(parseDocumentSyncReady({ ...ready, viewGeneration: '' })).toBeNull();
  });

  it('parses a correlated host flush barrier', () => {
    const barrier = {
      type: 'flushPendingEdit',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      requestId: 'save-flush-1',
      viewGeneration: 'view-ready-1',
      documentVersion: 9,
    } as const;

    expect(parseDocumentFlushBarrier(barrier)).toEqual(barrier);
    expect(parseDocumentFlushBarrier({ ...barrier, requestId: '' })).toBeNull();
    expect(parseDocumentFlushBarrier({ ...barrier, documentVersion: -1 })).toBeNull();
  });

  it('parses a renderer-generation-bound flush acknowledgement', () => {
    const acknowledgement = {
      type: 'flushPendingEditAck',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      requestId: 'save-flush-1',
      viewGeneration: 'view-ready-1',
      documentVersion: 9,
      ok: true,
    } as const;

    expect(parseDocumentFlushAck(acknowledgement)).toEqual(acknowledgement);
    expect(parseDocumentFlushAck({ ...acknowledgement, viewGeneration: '' })).toBeNull();
    expect(parseDocumentFlushAck({ ...acknowledgement, ok: 'yes' })).toBeNull();
  });

  it('parses a teardown edit that depends on the one in-flight renderer edit', () => {
    const teardownEdit = {
      type: 'document.teardown.edit',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      editId: 'view-ready-1:3:2',
      viewGeneration: 'view-ready-1',
      localRevision: 3,
      baseDocumentVersion: 8,
      predecessorEditId: 'view-ready-1:2:1',
      predecessorLocalRevision: 2,
      content: 'newest content before teardown',
    } as const;

    expect(parseDocumentTeardownEditMessage(teardownEdit)).toEqual(teardownEdit);
    expect(parseDocumentTeardownEditMessage({ ...teardownEdit, predecessorEditId: '' })).toBeNull();
    expect(
      parseDocumentTeardownEditMessage({ ...teardownEdit, predecessorLocalRevision: -1 })
    ).toBeNull();
  });

  it.each([
    ['foreign type', { type: 'edit.ack' }],
    ['negative document version', { documentVersion: -1 }],
    ['non-boolean acceptance', { accepted: 'yes' }],
  ])('rejects malformed acknowledgement fields: %s', (_, override) => {
    expect(
      parseDocumentEditAck({
        type: 'document.edit.ack',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: validEdit.editId,
        viewGeneration: validEdit.viewGeneration,
        localRevision: validEdit.localRevision,
        accepted: true,
        documentVersion: 8,
        ...override,
      })
    ).toBeNull();
  });
});
