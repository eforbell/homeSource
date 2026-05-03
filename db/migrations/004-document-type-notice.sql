-- HomeSource: add notice document type

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_document_type_check;
ALTER TABLE documents
  ADD CONSTRAINT documents_document_type_check CHECK (document_type IN (
    'warranty', 'insurance', 'certificate', 'manual',
    'receipt', 'contract', 'medical', 'legal', 'tax',
    'identification', 'property', 'vehicle', 'notice', 'other'
  ));
