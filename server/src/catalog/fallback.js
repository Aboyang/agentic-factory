// Offers verified against the Reap sandbox on 9 Oct 2026 (search + quote).
// Used only when live search finds nothing usable, so the demo never dead-ends.

const SE = 'Switch Electronics';
const img = (path) => `https://cdn.shopify.com/s/files/${path}`;

export const FALLBACK_OFFERS = {
  'prox-sensor': { productId: 'prd_cfaf1ffa1cb049bf97842a464db67282', variantId: 'var_3021de06ffcc4c4cb691f13beb2e81d1', name: 'NO 5mm NPN Long Inductive Proximity Sensor - PIN-T18L-001', merchant: SE, price: 17.69, image: img('1/0695/1347/8453/files/37cea605-332d-47c4-9a4a-9d4f55003d45.jpg') },
  'relay-board': { productId: 'prd_b6ecdc72c76a43dbb7b27a95038c8cab', variantId: 'var_0a9e5aed97444e2897d548e7f625dc0a', name: '12V 4-Channel Relay Board Module Active Low', merchant: SE, price: 6.71, image: img('1/0695/1347/8453/files/2da759de-9e95-41cd-933e-7fbe32bd4939.jpg') },
  'limit-switch': { productId: 'prd_ab716d366446478095d3dccd6093ec3e', variantId: 'var_dda30270fcd94e50b97b2ed97e71b807', name: 'Adjustable Big Roller Arm Industrial Limit Switch IP65 10A 250V', merchant: SE, price: 9.56, image: img('1/0695/1347/8453/files/fcb7ec67-e694-4236-ae7e-9d0b1bbc9e5e.jpg') },
  'arm-psu': { productId: 'prd_63e5531653bc4d05ac97f7d9a0201be0', variantId: 'var_8b55beaa92bd42f88215c0d5ce8581dd', name: '24V 4.5A Enclosed Switching Power Supply 100W', merchant: SE, price: 19.23, image: img('1/0695/1347/8453/files/03379f23-294a-4707-ade2-530f43833258.jpg') },
  estop: { productId: 'prd_b5bc79f94f41459e816baf1097360a75', variantId: 'var_ecfdc8dbd61f4463812bebf16885a6a2', name: 'Emergency Stop 16mm Push Button Switch Stainless Steel 5A', merchant: SE, price: 18.62, image: img('1/0695/1347/8453/files/4900baa5-6cce-46dc-ab9c-72379406a992_df50b7c0-9b3e-42d1-97d7-c4a700239aa3.jpg') },
  'gripper-servo': { productId: 'prd_3887a450a39a44788896a371e46828bb', variantId: 'var_29cdaaaee24145d7840bbfca4bc72628', name: 'FT5330M High Torque 67g 35.5Kg/cm Digital 180° Rotation Servo FeeTech', merchant: SE, price: 26.32, image: img('1/0695/1347/8453/files/92e55dba-c087-4bb7-8832-87ccff104209.jpg') },
  'arm-driver': { productId: 'prd_ac2ea84fffe74efc82f413afbb06d369', variantId: 'var_3ffa091d38584e009dedb323168ad37a', name: 'L298N DC Stepper Motor Dual H Bridge Drive Controller Board Module', merchant: SE, price: 5.13, image: img('1/0695/1347/8453/files/c7d7bab7-926e-475d-a503-6b58d1319089.jpg') },
  'motor-driver': { productId: 'prd_ac2ea84fffe74efc82f413afbb06d369', variantId: 'var_3ffa091d38584e009dedb323168ad37a', name: 'L298N DC Stepper Motor Dual H Bridge Drive Controller Board Module', merchant: SE, price: 5.13, image: img('1/0695/1347/8453/files/c7d7bab7-926e-475d-a503-6b58d1319089.jpg') },
  'main-fuse': { productId: 'prd_144c7d0043a04824afb8929927f38add', variantId: 'var_877e8d8213a3416d94a251e39a986621', name: '5A 5x20mm Glass Quick Blow Fuse 250V', merchant: SE, price: 0.19, image: img('1/0695/1347/8453/files/3b740a88-a381-49b5-a830-5287aeee5492.jpg') },
  'cooling-fan': { productId: 'prd_be511d9b6175465ebba888a9963d70bb', variantId: 'var_b3adadae121147a7924863d27259f7e8', name: '120 x 120 x 25mm Axial Sleeve Bearing Fan 12V', merchant: SE, price: 6.21, image: img('1/0695/1347/8453/files/0261e599-cf86-4660-87f3-6d8936c14a69.jpg') },
  'drive-motor': { productId: 'prd_ae41889b75a748ad996696651d6a4b57', variantId: 'var_9f2b9465cfa148dead478e33c45a2456', name: 'Official Creality 42-40 Stepper Motor', merchant: 'Digitmakers.ca', price: 14.0, image: img('1/1745/6181/files/42-40-2.png') },
  'net-switch': { productId: 'prd_9be9542e40ef414b8a197ec5b6022a02', variantId: 'var_d46c111d4b2b4b3492dce9749d9924fe', name: 'TP-Link TL-SG108PE Gigabit PoE Switch', merchant: 'Tech For Less', price: 58.97, image: img('1/0725/7020/8392/files/949d9c7c-b9cd-4365-9c0f-552e51d8e218.jpg') },
};
