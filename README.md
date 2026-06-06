# 🎉 Goûter de fin d'année

Site temps réel pour organiser le goûter de la classe : chacun s'inscrit avec
son prénom et rejoint un groupe par thème.

## ⚠️ Important — il faut lancer le serveur

Le site **ne marche pas** si on ouvre `index.html` tout seul : il a besoin du
serveur Node.js (c'est lui qui gère le temps réel et les compteurs).

## Lancer le site

```bash
npm install      # une seule fois
npm start        # démarre le serveur
```

Puis ouvre **http://localhost:3000** dans le navigateur.

Tout le monde sur le même réseau peut se connecter avec l'adresse IP de la
machine (ex : `http://192.168.1.20:3000`).

## Comment ça marche

- **Inscription** : on entre son prénom (reconnu même sans accent ni
  majuscule — `Léo` = `LEO` = `leo`).
- **Thèmes** (Boisson, Saucisson, Gâteau, Chips) : on clique « Rejoindre »,
  c'est direct, sans limite de personnes.
- **Autre** : on indique ce qu'on apporte (ex : « Bonbons ») — une entrée
  perso d'une personne.
- Tout est **en temps réel** : les groupes, les compteurs et la liste des
  inscrits se mettent à jour chez tout le monde instantanément.
- Un **bandeau rouge** apparaît en haut si la connexion au serveur est perdue.
