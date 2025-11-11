
import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { FC } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = (error) => reject(error);
  });
};

const getImageAspectRatio = (file: File): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
      const divisor = gcd(img.naturalWidth, img.naturalHeight);
      resolve(`${img.naturalWidth / divisor}:${img.naturalHeight / divisor}`);
      URL.revokeObjectURL(img.src);
    };
  });
};


const App: FC = () => {
  const [modelImage, setModelImage] = useState<File | null>(null);
  const [productImage, setProductImage] = useState<File | null>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [userPrompt, setUserPrompt] = useState<string>('');
  const [aspectRatio, setAspectRatio] = useState<string>('1:1');
  const [inpaintingPrompt, setInpaintingPrompt] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<boolean>(false);

  // Inpainting state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [inpaintingTool, setInpaintingTool] = useState<'brush' | 'eraser'>('brush');
  const [brushSize, setBrushSize] = useState<number>(40);
  
  const generatedImageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (editMode && canvasRef.current && generatedImageRef.current) {
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      const img = generatedImageRef.current;
      
      const setCanvasSize = () => {
        if(img.naturalWidth > 0 && img.naturalHeight > 0) {
            canvas.width = img.clientWidth;
            canvas.height = img.clientHeight;
             if (context) {
              context.clearRect(0, 0, canvas.width, canvas.height);
            }
        }
      };

      if (img.complete) {
        setCanvasSize();
      } else {
        img.onload = setCanvasSize;
      }
      
      const resizeObserver = new ResizeObserver(setCanvasSize);
      resizeObserver.observe(img);

      return () => {
        resizeObserver.disconnect();
      }
    }
  }, [editMode]);

  const getCanvasCoordinates = (event: React.MouseEvent<HTMLCanvasElement>): { x: number, y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width * canvas.width,
      y: (event.clientY - rect.top) / rect.height * canvas.height
    };
  };

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    const { x, y } = getCanvasCoordinates(e);
    context.beginPath();
    context.moveTo(x, y);
    setIsDrawing(true);
  };

  const finishDrawing = () => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    context.closePath();
    setIsDrawing(false);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;

    const { x, y } = getCanvasCoordinates(e);
    
    context.globalCompositeOperation = inpaintingTool === 'brush' ? 'source-over' : 'destination-out';
    context.strokeStyle = inpaintingTool === 'brush' ? 'rgba(239, 68, 68, 0.6)' : 'rgba(0,0,0,1)';
    context.fillStyle = inpaintingTool === 'brush' ? 'rgba(239, 68, 68, 0.6)' : 'rgba(0,0,0,1)';
    context.lineWidth = brushSize;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    context.lineTo(x, y);
    context.stroke();
  };
  
  const generateMask = (): Promise<string> => {
    return new Promise((resolve) => {
        const userCanvas = canvasRef.current;
        if (!userCanvas) return resolve("");
  
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = userCanvas.width;
        maskCanvas.height = userCanvas.height;
        const maskCtx = maskCanvas.getContext('2d')!;

        // 1. Fill the mask with white
        maskCtx.fillStyle = 'white';
        maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
        
        // 2. Draw the user's drawing (the red overlay) onto the mask
        maskCtx.drawImage(userCanvas, 0, 0);

        // 3. Use 'source-in' to turn the drawn parts black
        maskCtx.globalCompositeOperation = 'source-in';
        maskCtx.fillStyle = 'black';
        maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);

        resolve(maskCanvas.toDataURL('image/png').split(',')[1]);
    });
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'model' | 'product') => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (type === 'model') setModelImage(file);
      if (type === 'product') setProductImage(file);
    }
  };

  const callGeminiAPI = async (parts: any[], prompt: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [...parts, { text: prompt }] },
        config: {
          responseModalities: [Modality.IMAGE],
        },
      });

      const firstPart = response.candidates?.[0]?.content?.parts?.[0];
      if (firstPart?.inlineData) {
        const base64ImageBytes = firstPart.inlineData.data;
        setGeneratedImage(`data:image/png;base64,${base64ImageBytes}`);
        setEditMode(false);
      } else {
        throw new Error('No image was generated. Please try a different prompt or images.');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unexpected error occurred.');
      setGeneratedImage(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!modelImage || !productImage) {
      setError('Please upload both a model image and a product image.');
      return;
    }
    const modelImageBase64 = await fileToBase64(modelImage);
    const productImageBase64 = await fileToBase64(productImage);

    const parts = [
      { inlineData: { mimeType: 'image/jpeg', data: modelImageBase64 } },
      { inlineData: { mimeType: 'image/jpeg', data: productImageBase64 } },
    ];
    
    let prompt = userPrompt || `From the second image (product), take the apparel item and realistically place it onto the person in the first image (model). Replace the person's current clothing with the new item.`;
    prompt += ` The new clothing must conform to the person's body shape, pose, and the scene's lighting. Preserve all details like pattern, texture, and logos from the product image.`;

    let targetAspectRatio = aspectRatio;
    if (aspectRatio === 'model' && modelImage) {
        targetAspectRatio = await getImageAspectRatio(modelImage);
    } else if (aspectRatio === 'product' && productImage) {
        targetAspectRatio = await getImageAspectRatio(productImage);
    }
    if (targetAspectRatio !== 'model' && targetAspectRatio !== 'product') {
       prompt += ` Generate the final image with a ${targetAspectRatio} aspect ratio.`;
    }

    callGeminiAPI(parts, prompt);
  };
  
  const handleInpaint = async () => {
      if (!generatedImage || !inpaintingPrompt) {
          setError("Please provide a description for what to change in the selected area.");
          return;
      }
      const maskBase64 = await generateMask();
      if (!maskBase64) {
          setError("Could not create the edit mask. Please try drawing on the image again.");
          return;
      }
      const generatedImageBase64 = generatedImage.split(',')[1];
  
      const parts = [
          { inlineData: { mimeType: 'image/png', data: generatedImageBase64 } },
          { inlineData: { mimeType: 'image/png', data: maskBase64 } },
      ];
  
      const prompt = `In the first image, redraw the area marked in black in the second image (the mask). The new content should be: "${inpaintingPrompt}". Blend it seamlessly with the rest of the image.`;
  
      callGeminiAPI(parts, prompt);
  };

  const ImageUploader: FC<{
    onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
    imageFile: File | null;
    title: string;
    id: string;
  }> = ({ onUpload, imageFile, title, id }) => (
    <div className="bg-slate-100 dark:bg-slate-800 p-4 rounded-lg shadow-inner w-full flex flex-col items-center justify-center min-h-[300px]">
      <h3 className="text-lg font-semibold mb-2 text-slate-700 dark:text-slate-300">{title}</h3>
      <div className="w-full aspect-square border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-md flex items-center justify-center relative overflow-hidden">
        {imageFile ? (
          <img src={URL.createObjectURL(imageFile)} alt={title} className="w-full h-full object-contain" />
        ) : (
          <span className="text-slate-500">Upload an image</span>
        )}
        <input
          type="file"
          id={id}
          accept="image/*"
          onChange={onUpload}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label={`Upload ${title}`}
        />
      </div>
    </div>
  );

  const modelImageUrl = useMemo(() => modelImage ? URL.createObjectURL(modelImage) : null, [modelImage]);
  const productImageUrl = useMemo(() => productImage ? URL.createObjectURL(productImage) : null, [productImage]);

  useEffect(() => {
    return () => {
        if (modelImageUrl) URL.revokeObjectURL(modelImageUrl);
        if (productImageUrl) URL.revokeObjectURL(productImageUrl);
    }
  }, [modelImageUrl, productImageUrl]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 p-4 sm:p-6 lg:p-8 font-sans">
      <main className="max-w-7xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white mb-2">AI Virtual Try-On</h1>
          <p className="text-lg text-slate-600 dark:text-slate-400">Upload a model and a product, give instructions, and see the magic happen.</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <ImageUploader onUpload={(e) => handleImageUpload(e, 'model')} imageFile={modelImage} title="Model Image" id="model-upload" />
          <ImageUploader onUpload={(e) => handleImageUpload(e, 'product')} imageFile={productImage} title="Product Image" id="product-upload" />

          <div className="bg-slate-100 dark:bg-slate-800 p-4 rounded-lg shadow-inner w-full flex flex-col items-center justify-center min-h-[300px]">
            <h3 className="text-lg font-semibold mb-2 text-slate-700 dark:text-slate-300">Result</h3>
             <div className="w-full aspect-square flex items-center justify-center relative bg-slate-200 dark:bg-slate-700 rounded-md overflow-hidden">
              {isLoading && (
                 <div className="flex flex-col items-center gap-2 text-sky-500">
                    <svg className="animate-spin h-8 w-8" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    <span>Generating...</span>
                </div>
              )}
              {!isLoading && !generatedImage && ( <span className="text-slate-500">Result will appear here</span> )}
              {!isLoading && generatedImage && (
                <>
                  <img ref={generatedImageRef} src={generatedImage} alt="Generated result" className="max-w-full max-h-full object-contain" style={{ visibility: editMode ? 'hidden' : 'visible' }} />
                  {editMode && (
                     <div className='absolute inset-0 w-full h-full'>
                        <img src={generatedImage} alt="background" className="w-full h-full object-contain pointer-events-none" />
                        <canvas
                          ref={canvasRef}
                          className="absolute top-0 left-0 w-full h-full cursor-crosshair"
                          onMouseDown={startDrawing}
                          onMouseUp={finishDrawing}
                          onMouseOut={finishDrawing}
                          onMouseMove={draw}
                        />
                     </div>
                  )}
                </>
              )}
             </div>
          </div>
        </div>
        
        {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-md relative my-4 text-center" role="alert">
                <strong className="font-bold">Error: </strong>
                <span className="block sm:inline">{error}</span>
            </div>
        )}

        <div className="bg-white dark:bg-slate-800 p-4 rounded-lg shadow-lg mb-6">
            <label htmlFor="user-prompt" className="block text-lg font-medium text-slate-700 dark:text-slate-300 mb-2">Instructions</label>
            <textarea
                id="user-prompt"
                value={userPrompt}
                onChange={(e) => setUserPrompt(e.target.value)}
                placeholder="Describe what you want to do, e.g., 'replace the model's shirt with the product'."
                className="w-full p-2 border rounded-md bg-slate-50 dark:bg-slate-700 dark:border-slate-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                rows={3}
                aria-label="User instructions for generation"
            />
        </div>

        {editMode ? (
             <div className="bg-white dark:bg-slate-800 p-4 rounded-lg shadow-lg flex flex-col gap-4">
                <div className="flex flex-col md:flex-row items-center gap-4">
                    <input
                        type="text"
                        value={inpaintingPrompt}
                        onChange={(e) => setInpaintingPrompt(e.target.value)}
                        placeholder="Describe your edit (e.g., 'fix the sleeve')"
                        className="flex-grow p-2 border rounded-md bg-slate-50 dark:bg-slate-700 dark:border-slate-600 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        aria-label="Inpainting prompt"
                    />
                     <div className="flex gap-2">
                        <button onClick={handleInpaint} disabled={isLoading || !inpaintingPrompt} className="px-4 py-2 bg-green-600 text-white font-semibold rounded-lg shadow-md hover:bg-green-700 disabled:bg-slate-400 disabled:cursor-not-allowed transition-colors">
                            Apply Edit
                        </button>
                        <button onClick={() => setEditMode(false)} className="px-4 py-2 bg-slate-500 text-white font-semibold rounded-lg shadow-md hover:bg-slate-600 transition-colors">
                            Cancel
                        </button>
                    </div>
                </div>
                <div className="flex flex-col sm:flex-row items-center gap-4 p-2 border-t border-slate-200 dark:border-slate-700 pt-4">
                    <div className='font-medium'>Tools:</div>
                    <div className='flex gap-2'>
                        <button onClick={() => setInpaintingTool('brush')} className={`px-3 py-1 rounded-md text-sm ${inpaintingTool === 'brush' ? 'bg-sky-600 text-white' : 'bg-slate-200 dark:bg-slate-600'}`}>Brush</button>
                        <button onClick={() => setInpaintingTool('eraser')} className={`px-3 py-1 rounded-md text-sm ${inpaintingTool === 'eraser' ? 'bg-sky-600 text-white' : 'bg-slate-200 dark:bg-slate-600'}`}>Eraser</button>
                    </div>
                    <div className='flex items-center gap-2'>
                        <label htmlFor="brush-size" className='text-sm'>Size:</label>
                        <input type="range" id="brush-size" min="5" max="100" value={brushSize} onChange={e => setBrushSize(Number(e.target.value))} className='w-32' />
                    </div>
                </div>
             </div>
        ) : (
            <div className="flex flex-col sm:flex-row justify-center items-center gap-4">
                <div className="flex items-center gap-2">
                    <label htmlFor="aspect-ratio" className="font-medium">Aspect Ratio:</label>
                    <select id="aspect-ratio" value={aspectRatio} onChange={e => setAspectRatio(e.target.value)} className="p-2 border rounded-md bg-slate-50 dark:bg-slate-700 dark:border-slate-600 focus:ring-2 focus:ring-sky-500 focus:outline-none">
                        <option value="model">Model Ratio</option>
                        <option value="product">Product Ratio</option>
                        <option value="1:1">1:1</option>
                        <option value="3:4">3:4</option>
                        <option value="4:3">4:3</option>
                        <option value="2:3">2:3</option>
                        <option value="3:2">3:2</option>
                    </select>
                </div>
              <button onClick={() => handleGenerate()} disabled={isLoading || !modelImage || !productImage} className="px-6 py-3 bg-sky-600 text-white font-semibold rounded-lg shadow-md hover:bg-sky-700 disabled:bg-slate-400 disabled:cursor-not-allowed transition-all duration-300">
                {isLoading ? 'Generating...' : 'Generate'}
              </button>
              <button onClick={() => handleGenerate()} disabled={isLoading || !generatedImage} className="px-6 py-3 bg-slate-600 text-white font-semibold rounded-lg shadow-md hover:bg-slate-700 disabled:bg-slate-400 disabled:cursor-not-allowed transition-all duration-300">
                Regenerate
              </button>
              <button onClick={() => setEditMode(true)} disabled={isLoading || !generatedImage} className="px-6 py-3 bg-amber-500 text-white font-semibold rounded-lg shadow-md hover:bg-amber-600 disabled:bg-slate-400 disabled:cursor-not-allowed transition-all duration-300">
                Edit / Inpaint
              </button>
            </div>
        )}

      </main>
    </div>
  );
};

export default App;
