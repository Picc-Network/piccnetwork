export const config = {
  matcher: ['/dashboard.html', '/api/status'],
};

export default function middleware(request) {
  const validUser = process.env.DASHBOARD_USER || 'admin';
  const validPassword = process.env.DASHBOARD_PASSWORD;

  // Se la password non è stata impostata su Vercel, blocchiamo tutto per sicurezza
  // invece di lasciare la dashboard aperta per errore.
  if (!validPassword) {
    return new Response('Dashboard non configurata: manca la variabile DASHBOARD_PASSWORD', { status: 500 });
  }

  const authHeader = request.headers.get('authorization');

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = atob(encoded);
      const separatorIndex = decoded.indexOf(':');
      const user = decoded.substring(0, separatorIndex);
      const password = decoded.substring(separatorIndex + 1);
      if (user === validUser && password === validPassword) {
        return; // credenziali corrette: lascia passare la richiesta
      }
    }
  }

  return new Response('Accesso non autorizzato', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="PICC Network Dashboard"',
    },
  });
}
