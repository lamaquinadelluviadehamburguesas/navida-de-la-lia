import { getApps, initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyC9WU4p6FzWHRwkPMIgrCnXMZ4VEB0oE74',
  authDomain: 'polinitech.firebaseapp.com',
  projectId: 'polinitech',
  storageBucket: 'polinitech.firebasestorage.app',
  messagingSenderId: '53968684374',
  appId: '1:53968684374:web:4c35fb21404c09ebf342f7'
};

// Reutiliza la aplicación predeterminada durante las recargas de desarrollo.
export const app = getApps().find(existingApp => existingApp.name === '[DEFAULT]')
  ?? initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);

let galleryUserPromise = null;

// Restaura la sesión persistida y crea una identidad solo cuando hace falta.
export function ensureGalleryUser() {
  if (!galleryUserPromise) {
    galleryUserPromise = (async () => {
      await auth.authStateReady();
      if (auth.currentUser) return auth.currentUser;
      return (await signInAnonymously(auth)).user;
    })().finally(() => { galleryUserPromise = null; });
  }
  return galleryUserPromise;
}

// Se llama tras restaurar la sesión, con el UID propietario de la suscripción.
export function onGalleryIdentityChange(ownerUid, callback) {
  return onAuthStateChanged(auth, user => {
    if (user?.uid !== ownerUid) callback(user);
  });
}
