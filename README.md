# ATLAS Investment OS — Alpha 22.2

Este pacote contém o projeto completo e o workflow do GitHub Pages.

## Importação no GitHub

Na raiz do repositório, substitui ou adiciona exatamente estes elementos:

- `.github/`
- `.nojekyll`
- `index.html`
- `service-worker.js`
- `manifest.webmanifest`
- `version.json`
- `icon-192.png`
- `icon-512.png`

O ficheiro `market-data-index.ts` não vai para a raiz pública. Serve apenas para atualizar a função `market-data` no Supabase.

## Supabase

Abre:

`Edge Functions → market-data → Code`

Apaga o código atual, cola todo o conteúdo de `market-data-index.ts` e escolhe **Deploy updates**.

## Publicação

Depois do upload/commit, o workflow:

`Deploy ATLAS to GitHub Pages`

faz a publicação automaticamente.

Em `Settings → Pages`, a origem deve ficar em:

`GitHub Actions`

Não é necessário voltar a escolher branch ou pasta.

## Teste

1. Espera o workflow ficar verde.
2. Abre:
   `https://jack221089-dotcom.github.io/atlas-investment-os/`
3. Confirma:
   `Version 3.0.0 Alpha 22.2`
4. Abre **Radar Inteligente** e escolhe **Analisar mercado**.

## Correções incluídas

- versão visível gerada automaticamente;
- atalhos da PWA abrem Dashboard e Carteira corretamente;
- atualização do service worker mais robusta;
- atualização e eliminação de dados também filtradas pelo utilizador;
- workflow único e oficial do GitHub Pages.
