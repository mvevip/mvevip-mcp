export interface Mailer {
  sendVerificationCode(to: string, code: string): Promise<void>;
}

const subject = 'Código de verificación MVEVIP';
const textBody = (code: string) =>
  `Su código de verificación para vincular el conector MVEVIP es: ${code}\n\n` +
  'Vence en 10 minutos. Si usted no lo solicitó, ignore este correo y avise a su administrador.';
const htmlBody = (code: string) =>
  `<div style="font-family:Arial,sans-serif;max-width:480px">
     <h2>MVEVIP Corporate MCP</h2>
     <p>Su código de verificación para vincular el conector es:</p>
     <p style="font-size:32px;letter-spacing:6px;font-weight:bold">${code}</p>
     <p>Vence en 10 minutos. Si usted no lo solicitó, ignore este correo y avise a su administrador.</p>
   </div>`;

export class SesMailer implements Mailer {
  constructor(private readonly from: string, private readonly region = process.env.AWS_REGION || 'us-east-1') {}

  async sendVerificationCode(to: string, code: string): Promise<void> {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const client = new SESv2Client({ region: this.region });
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: textBody(code), Charset: 'UTF-8' },
              Html: { Data: htmlBody(code), Charset: 'UTF-8' }
            }
          }
        }
      })
    );
  }
}

/** Solo desarrollo local: escribe el código en consola en lugar de enviarlo. */
export class ConsoleMailer implements Mailer {
  async sendVerificationCode(to: string, code: string): Promise<void> {
    console.log(`[MAIL:console] Código para ${to}: ${code}`);
  }
}

export const createMailerFromEnv = (): Mailer => {
  const transport = (process.env.MAIL_TRANSPORT || 'ses').toLowerCase();
  if (transport === 'console') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MAIL_TRANSPORT=console no está permitido en producción.');
    }
    return new ConsoleMailer();
  }
  const from = process.env.MAIL_FROM;
  if (!from) throw new Error('MAIL_FROM es obligatoria (ej: "MVEVIP <no-reply@mvevip.com>").');
  return new SesMailer(from);
};
