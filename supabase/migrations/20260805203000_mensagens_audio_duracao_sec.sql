-- Duração de áudio/voice outbound (e inbound quando disponível), em segundos inteiros.
-- O frontend já envia audio_duration_ms no upload; sem esta coluna o valor era descartado
-- e a bolha ficava 0:00 até o player decodificar o arquivo.

ALTER TABLE public.mensagens
  ADD COLUMN IF NOT EXISTS audio_duracao_sec INTEGER DEFAULT NULL;

COMMENT ON COLUMN public.mensagens.audio_duracao_sec
  IS 'Duração do áudio/voice em segundos (inteiro). Preenchida no envio CRM a partir de audio_duration_ms; opcional em inbound.';
