# Ticket PHRONESIS — Cérémonie de Remise de Parchemins

Site de vente de tickets en ligne avec paiement Wave / Orange Money via SenePay,
et envoi automatique du ticket par email après paiement.

## Déploiement (étape par étape)

### 1. Mettre le code sur GitHub
1. Va sur github.com → bouton vert **"New repository"**
2. Donne-lui un nom, ex: `ticket-phronesis`, laisse en "Public" ou "Private", clique **"Create repository"**
3. Sur la page suivante, clique **"uploading an existing file"**
4. Glisse-dépose TOUS les fichiers et dossiers de ce projet (sauf `.env`, qui ne doit jamais être uploadé)
5. Clique **"Commit changes"**

### 2. Déployer sur Render
1. Va sur render.com → **"New +"** → **"Web Service"**
2. Connecte ton compte GitHub, choisis le repository `ticket-phronesis`
3. Render détecte Node.js automatiquement. Laisse :
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Choisis le plan **Free**
5. Avant de cliquer "Create", va dans **"Environment Variables"** et ajoute toutes les variables du fichier `.env.example` (avec tes vraies valeurs, pas les exemples)
   - `BASE_URL` : laisse vide pour l'instant, tu la complèteras après le premier déploiement avec l'URL que Render te donne (ex: `https://ticket-phronesis.onrender.com`)
6. Clique **"Create Web Service"** et attends la fin du déploiement (quelques minutes)
7. Une fois déployé, copie l'URL de ton site, reviens dans Environment Variables, mets-la dans `BASE_URL`, et clique "Save" (le site redémarre automatiquement)

### 3. Configurer le webhook dans SenePay
1. Dashboard SenePay → **Dev** → trouve la section Webhooks (ou clés API)
2. Renseigne l'URL : `https://TON-SITE.onrender.com/api/webhooks/senepay`
3. Récupère le `webhookSigningSecret` (commence par `whsec_`) et mets-le dans la variable `SENEPAY_WEBHOOK_SECRET` sur Render

### 4. Tester en Sandbox AVANT de vendre pour de vrai
1. Utilise tes clés `pk_test_*` / `sk_test_*` dans les variables Render (pas les clés `pk_live_*`)
2. Va sur ton site, remplis le formulaire, choisis Wave ou Orange Money
3. Sur la page de paiement, utilise un des numéros de test (ex. Sénégal: `700000001` = succès)
4. Vérifie que :
   - Tu es redirigé vers la page "Paiement reçu"
   - Tu reçois bien l'email avec le ticket en pièce jointe (vérifie aussi les spams)
   - Le nom apparaît dans `/admin?password=TON_MOT_DE_PASSE`

### 5. Passer en production
1. Remplace les clés Sandbox par tes clés `pk_live_*` / `sk_live_*` dans Render
2. Refais un petit test avec un vrai (petit) paiement si possible
3. Partage le lien de ton site (l'URL Render, ou un nom de domaine si tu en achètes un) sur WhatsApp/Instagram

## Le jour de l'événement
Ouvre `https://TON-SITE.onrender.com/admin?password=TON_MOT_DE_PASSE` sur ton téléphone
pour voir la liste des personnes ayant payé et vérifier les noms à l'entrée.
Tu peux aussi télécharger la liste en CSV depuis cette page.

## Important
- Le plan gratuit de Render "s'endort" après 15 minutes d'inactivité et se réveille au premier visiteur (quelques secondes de délai). Ça n'affecte pas les paiements déjà en cours.
- Ne redéploie pas le site après le lancement de la vente sans backup : la liste des payés est stockée dans un simple fichier, perdu si tu redéploies. Télécharge le CSV régulièrement par sécurité.
